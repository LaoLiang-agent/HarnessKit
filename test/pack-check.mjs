// Verify the tarball npm would publish: file list, bundle wiring, imports, locales.
// Usage: node test/pack-check.mjs   (from the bundle root; exits non-zero on failure)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const failures = []
const fail = (message) => failures.push(message)
const ok = (message) => console.log('ok  ', message)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-pack-'))
try {
  const packDir = path.join(tmp, 'pack')
  const extractDir = path.join(tmp, 'extract')
  fs.mkdirSync(packDir)
  fs.mkdirSync(extractDir)

  const stdout = execFileSync(npm, ['pack', '--pack-destination', packDir, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_loglevel: 'error',
      // Keep npm's own logs and cache inside the temporary directory so a
      // sandboxed or read-only home directory cannot fail the check.
      npm_config_logs_dir: path.join(tmp, 'npm-logs'),
      npm_config_cache: path.join(tmp, 'npm-cache'),
    },
  })
  const tarball = path.join(packDir, JSON.parse(stdout)[0].filename)
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir])
  const pkgRoot = path.join(extractDir, 'package')

  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  if (pkg.private) fail('package.json is still private')
  if (!pkg.dsh?.bundle?.patch) fail('package.json is missing dsh.bundle.patch')
  if (!pkg.engines?.dsh) fail('package.json is missing engines.dsh')
  ok(`identity ${pkg.name}@${pkg.version}, dsh ${pkg.engines?.dsh}`)

  const patch = fs.readFileSync(path.join(pkgRoot, pkg.dsh.bundle.patch), 'utf8')
  if (!patch.includes(`name: '${pkg.name}'`)) fail('cordis.patch.yml does not name the package')
  if (!patch.includes('id: harness-kit')) fail('cordis.patch.yml is missing the harness-kit row')
  ok('bundle patch references the package name')

  const client = fs.readFileSync(path.join(pkgRoot, 'client.js'), 'utf8')
  const id = client.match(/id:\s*'([^']+)'/)?.[1]
  if (id !== pkg.name) fail(`client module id ${id} does not match ${pkg.name}`)
  ok('client module id matches the package name')

  for (const file of ['index.js', 'client.js', 'icon.svg', 'README.md', 'README.zh-CN.md', pkg.dsh.bundle.patch]) {
    if (!fs.existsSync(path.join(pkgRoot, file))) fail(`missing ${file}`)
  }
  for (const file of fs.readdirSync(path.join(pkgRoot, 'locale'))) {
    if (!file.endsWith('.json')) continue
    const locale = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'locale', file), 'utf8'))
    if (!locale.meta?.title || !locale.meta?.description) fail(`locale/${file} meta is incomplete`)
    if (!locale.meta?.detail || !fs.existsSync(path.join(pkgRoot, locale.meta.detail))) {
      fail(`locale/${file} meta.detail does not resolve`)
    }
  }
  ok('locale metadata and detail document')

  for (const file of ['docs/DETAIL.md', 'docs/DETAIL.en.md']) {
    const document = fs.readFileSync(path.join(pkgRoot, file), 'utf8')
    for (const match of document.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = path.resolve(path.dirname(path.join(pkgRoot, file)), match[1])
      if (!fs.existsSync(target)) fail(`${file} image ${match[1]} is missing`)
    }
  }
  ok('detail document images resolve inside the tarball')

  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key.includes('*')) continue
    if (!fs.existsSync(path.join(pkgRoot, target))) fail(`export ${key} -> ${target} is missing`)
  }
  // 飞书 SDK 必须已预打包：运行时不装 @larksuiteoapi/node-sdk，避免 protobufjs 构建审批
  if (pkg.dependencies?.['@larksuiteoapi/node-sdk']) fail('runtime dependency @larksuiteoapi/node-sdk must be dev-only')
  for (const file of ['kernel/im/vendor/feishu-sdk.cjs', 'kernel/im/vendor/LARKSDK-LICENSE']) {
    if (!fs.existsSync(path.join(pkgRoot, file))) fail(`missing vendored Feishu file ${file}`)
  }
  const adapter = fs.readFileSync(path.join(pkgRoot, 'kernel/im/adapters/feishu.js'), 'utf8')
  if (adapter.includes("from '@larksuiteoapi/node-sdk'") || adapter.includes("import('@larksuiteoapi/node-sdk')")) {
    fail('Feishu adapter still imports the runtime SDK')
  }
  ok('Feishu SDK is vendored and not a runtime dependency')
  ok('exports targets exist')

  const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? jsFiles(path.join(dir, entry.name))
      : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : [])
  const checkImports = (file) => {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1])
      if (!fs.existsSync(target)) fail(`unresolved import ${match[1]} in ${path.relative(pkgRoot, file)}`)
    }
  }
  for (const file of [path.join(pkgRoot, 'index.js'), ...jsFiles(path.join(pkgRoot, 'kernel'))]) checkImports(file)
  ok('relative imports resolve inside the tarball')

  const mod = await import(pathToFileURL(path.join(pkgRoot, 'index.js')).href)
  if (typeof mod.apply !== 'function') fail('index.js does not export apply()')
  ok('index.js loads as an ES module and exports apply()')

  if (fs.readdirSync(path.join(pkgRoot, 'packs')).length === 0) fail('packs/ is empty')
  for (const file of [
    'packs/ai-coding/assets/templates/generic/root-AGENTS.tmpl',
    'packs/ai-coding/assets/templates/generic/CODE_STANDARDS.tmpl',
    'packs/ai-coding/assets/templates/generic/build.tmpl',
  ]) {
    if (!fs.existsSync(path.join(pkgRoot, file))) fail(`missing ${file}`)
  }
  ok('content pack is present')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\npack check failed:')
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('\npack check passed')
