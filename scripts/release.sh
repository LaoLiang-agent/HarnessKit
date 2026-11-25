#!/usr/bin/env bash
# Harness Kit 发版脚本：显式版本号 -> 校验/测试 -> bump -> commit -> tag -> push
# 只负责把 vX.Y.Z 推到远端；npm publish 由 CI 在 tag 上自动执行，本脚本绝不 publish。
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：scripts/release.sh <version> [--dry-run] [--no-push]

  <version>    必填，形如 0.3.2；必须由人明确给出，脚本不会自动推断
  --dry-run    只做校验和打印，不修改文件、不提交、不打 tag
  --no-push    完成 commit + tag，但不 push（留给你检查）

发版前需先手动写好 CHANGELOG.md 的 ## [<version>] 段落。
脚本不会执行 npm publish；推送 tag 后由 CI 自动发布。
USAGE
}

VERSION="${1:-}"
case "$VERSION" in -h|--help) usage; exit 0 ;; esac
shift || true
DRY_RUN=0
NO_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-push) NO_PUSH=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$VERSION" ] || { usage >&2; exit 2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CURRENT="$(node -p "require('./package.json').version")"
node - "$VERSION" "$CURRENT" <<'NODE'
const [next, cur] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`版本号格式不对：${next}（应为 X.Y.Z）`);
  process.exit(1);
}
const a = next.split('.').map(Number);
const b = cur.split('.').map(Number);
if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) {
  console.error(`版本号未变化：${cur}`);
  process.exit(1);
}
if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
  console.error(`新版本 ${next} 小于当前版本 ${cur}`);
  process.exit(1);
}
NODE

# 允许为发版先手写 CHANGELOG/README；其他未提交改动必须先处理
dirty="$(git status --porcelain | awk '{print $2}')"
for f in $dirty; do
  case "$f" in
    CHANGELOG.md|README.md|README.zh-CN.md) ;;
    *) echo "工作区有未提交改动：$f。发版前请先提交或清理。" >&2; exit 1 ;;
  esac
done

grep -q "^## \[$VERSION\]" CHANGELOG.md || {
  echo "CHANGELOG.md 缺少 ## [$VERSION] 段落；请先手写本轮变更。" >&2
  exit 1
}

BRANCH="$(git branch --show-current)"
echo "当前版本：$CURRENT"
echo "目标版本：$VERSION"
echo "当前分支：$BRANCH"
echo "模式：$([ "$DRY_RUN" -eq 1 ] && echo dry-run || echo execute)$([ "$NO_PUSH" -eq 1 ] && echo ' / no-push' || true)"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] 将执行 npm test / npm run pack:check"
  echo "[dry-run] 将更新 package.json、package-lock.json、README 版本"
  echo "[dry-run] 将提交 chore: release $VERSION，打 v$VERSION，并 push"
  exit 0
fi

npm test
npm run pack:check

# 不调用 npm version，避免 npm 的 git 清洁检查；只改版本字段
node - "$VERSION" <<'NODE'
const fs = require('fs');
const version = process.argv[2];
for (const file of ['package.json', 'package-lock.json']) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = version;
  if (file === 'package-lock.json' && data.packages && data.packages['']) data.packages[''].version = version;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
const link = `[${version}]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v${version}`;
if (!changelog.includes(link)) fs.appendFileSync('CHANGELOG.md', `\n${link}\n`);
NODE

node - "$VERSION" "$CURRENT" <<'NODE'
const fs = require('fs');
const [next, cur] = process.argv.slice(2);
for (const file of ['README.md', 'README.zh-CN.md']) {
  let text = fs.readFileSync(file, 'utf8').replaceAll(`@${cur}`, `@${next}`);
  fs.writeFileSync(file, text);
}
NODE

git add package.json package-lock.json CHANGELOG.md README.md README.zh-CN.md
git diff --cached --quiet && { echo "没有可提交的变更" >&2; exit 1; }
git commit -m "chore: release $VERSION"
git tag -a "v$VERSION" -m "Harness Kit $VERSION"

echo "已提交并打 tag：v$VERSION"
if [ "$NO_PUSH" -eq 1 ]; then
  echo "已按 --no-push 停止。检查后执行："
  echo "  git push origin $BRANCH && git push origin v$VERSION"
  exit 0
fi

git push origin "$BRANCH"
git push origin "v$VERSION"
echo "已推送 tag；CI 将自动发布 npm。不要再执行 npm publish。"
