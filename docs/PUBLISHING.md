# 发布与维护手册（Harness Kit）

本文是维护者手册，不随 npm 包发布（`files` 只包含 `docs/DETAIL.md` 与 `docs/DETAIL.en.md`）。

## 1. 发布物是什么

一个 DSH bundle 包，安装后：

- `dsh.bundle.patch` → `cordis.patch.yml` 插入 Host 行 `harness-kit`
- `dsh.client.platform: web` → 侧栏面板
- `exports` 暴露 `./locale/*.json`、`./icon`、`./client`、`./package.json`

没有构建步骤、没有运行时依赖、没有 install/postinstall 脚本。发布 = 打包源码目录。

## 2. 一次性准备

1. GitHub 仓库：`https://github.com/LaoLiang-agent/HarnessKit`（public），加 topic `dsh-plugin`。
2. npm：`npm login`（当前账号 `laoliang`），包名 `dsh-harness-kit` 已确认可用。
3. 首次提交与 tag：

   ```sh
   git init
   git add -A
   git commit -m "chore: publish dsh-harness-kit 0.1.0"
   git branch -M main
   git remote add origin https://github.com/LaoLiang-agent/HarnessKit.git
   git push -u origin main
   ```

4. （推荐）在 npmjs.com 配置 **Trusted Publishing**（GitHub Actions），之后 tag 发布不再需要任何
   token；具体步骤见 §3.6。`release.yml` 已按该模式写好，不再读取 `NPM_TOKEN`。

## 3. 每次发版清单

### 3.1 改版本与变更记录

- `package.json` 的 `version`（语义化版本；0.x 阶段破坏性变更走 minor）。
- `CHANGELOG.md` 增加条目，写清新增/变更/修复、DSH 兼容范围变化、用户需要做的迁移。
- 如果改动了 DSH 兼容范围，同步更新 `engines.dsh`、`README.md`、`README.zh-CN.md`、
  `docs/DETAIL.md`、`docs/DETAIL.en.md`、`.github` 中的说明，以及市场条目的描述（如涉及）。

### 3.2 本地质量门

```sh
node test/sim.mjs          # 回归（mock agent，不需要 DSH 运行时）
npm run pack:check         # 打包 tarball 并校验文件清单/导入/locale/dsh.bundle
git status --short         # 不应有未提交改动
```

打包清单必须包含：`index.js`、`client.js`、`cordis.patch.yml`、`kernel/**`、`packs/**`、
`locale/*.json`、`icon.svg`、`docs/DETAIL.md`、`docs/DETAIL.en.md`；
`README.md`、`README.zh-CN.md` 与 `LICENSE` 由 npm 自动带上（`pack:check` 会断言前两类文件存在）。

### 3.3 飞书 SDK 预打包

飞书 SDK 以预打包文件发布，运行时不安装 `@larksuiteoapi/node-sdk`，避免消费者被
`protobufjs` 的 postinstall 构建审批卡住。

- `@larksuiteoapi/node-sdk` 与 `esbuild` 只在 `devDependencies`
- 升级 SDK 后执行 `npm run vendor:feishu`
- 必须提交 `kernel/im/vendor/feishu-sdk.cjs` 与 `kernel/im/vendor/LARKSDK-LICENSE`
- `npm run pack:check` 会断言：vendor 存在、adapter 不再 import 运行时 SDK、runtime
  dependencies 里没有 `@larksuiteoapi/node-sdk`

不要把 `@larksuiteoapi/node-sdk` 加回 `dependencies`。

### 3.3 干净环境验证（不要用 `link:` 代替）

软链安装不会过滤 `files`，所以必须用 tarball 验证一次。`npm run pack:check` 已经自动检查
包结构、`dsh.bundle`、client id、locale 详情、导出路径与相对导入；剩下的是 DSH 真实装载：

```sh
npm pack
```

二选一验证：

- **图形界面**：Plugins → Add plugin，输入 tarball 的绝对路径，安装后确认插件行、
  命令 `/hk-doctor`、侧栏 Harness Kit 面板都正常。验证完可以卸载，再按 §7 恢复 `link:` 开发。
- **CLI**（需要 `dsh` 在 PATH，且 Desktop 已完全退出）：
  `dsh plugin --profile hktest add "$PWD/dsh-harness-kit-<version>.tgz"`，
  再 `dsh --profile hktest --dump-config | grep -A3 harness-kit`。

无论哪种方式，都要做一次**完全重启**后的冷启动验证——路由挂载用 `ctx.inject`，冷启动与热重载
是两条不同路径。

### 3.4 发布 npm

```sh
npm publish --access public
```

- 首次发布建议加 `--provenance`（需要公开仓库与 GitHub Actions 的 OIDC；只在本机发布时不要加）。
- 若 npm 账号开了发布 2FA，`npm publish` 会要求 OTP，并可能打开浏览器认证页。这一步必须由维护者
  在交互终端完成；把 OTP 交给别人或写进脚本都不安全。
- 非交互环境（CI、agent shell）发布失败会报 `EOTP`，这表示需要人工验证，不是配置错误。
- 发布后用 `npm view dsh-harness-kit version` 与 `npm view dsh-harness-kit dist-tags` 确认。
- 本仓库的 `release.yml` 在 tag 触发时会先查该版本是否已发布，已发布就跳过；所以手动发布过的
  版本再推 tag 也不会重复上传。

### 3.5 打 tag 与 Release

```sh
git tag -a v0.1.0 -m "dsh-harness-kit 0.1.0"
git push origin main --tags
```

GitHub Release 中附上 `npm pack` 生成的 tarball（`dsh-harness-kit-0.1.0.tgz`），供无法访问
npm 的用户安装；文件命名不要带版本号也可以，但 Release 资产名带版本时，市场条目要钉住 tag。

### 3.6 Trusted Publishing：彻底免 token

npm 的 Trusted Publishing 用 GitHub Actions 的 OIDC 短期凭据换取一次性发布权限，仓库里不再保存
长期 npm token。

前置条件：

- 包已经存在于 npm（本包 0.1.0 已发布，满足）
- npm CLI ≥ 11.5.1、Node ≥ 22.14（workflow 用 Node 24）
- 公开仓库（provenance 需要），`package.json` 的 `repository` 指向本仓库
- 使用 GitHub 托管的 `ubuntu-latest`，不支持 self-hosted runner

npm 侧配置：

1. 打开 `https://www.npmjs.com/package/dsh-harness-kit` → **Settings** → **Trusted Publishing**
2. 选择 **GitHub Actions**，填写：
   - Organization or user：`LaoLiang-agent`
   - Repository：`HarnessKit`
   - Workflow filename：`release.yml`（必须与实际文件名完全一致）
   - Environment：留空（除非 workflow 里用了 GitHub Environment，则两边必须一致）
   - Allowed actions：选 **npm publish**（界面若提供）
3. 保存；可能需要一次 OTP 确认

仓库侧（已就绪）：

- workflow 顶层 `permissions` 必须有 `id-token: write`，`contents: read`
- **不要**在 `setup-node` 里设置 `registry-url`，也**不要**设置 `NODE_AUTH_TOKEN`：
  空的 token 配置会让 npm 走 token 认证并挡住 OIDC
- 发布步骤直接 `npm publish --provenance --access public` 即可；公开仓库的 provenance 会自动生成
- 不再需要 `NPM_TOKEN` secret；确认一次发布成功后可以删除它

验证方式：把 `package.json` 升到新版本（如 `0.1.1`），更新 CHANGELOG，提交后打 tag：

```sh
git tag -a v0.1.1 -m "dsh-harness-kit 0.1.1"
git push origin main --tags
```

在 Actions 里确认 Release workflow 的 Publish 步骤成功，再 `npm view dsh-harness-kit@0.1.1`。

常见报错：

| 现象 | 原因 |
|---|---|
| `ENEEDAUTH` / `404 Not Found - PUT` | 缺 `id-token: write`，或 npm 侧 workflow 文件名/仓库不匹配 |
| `EOTP` | 仍在用 token 路径（`NODE_AUTH_TOKEN`/`registry-url` 未删） |
| `E422 repository.url` | `package.json` 的 `repository` 与 GitHub 仓库不一致 |
| `403 not authorized` | Trusted Publisher 的 owner/repo/workflow/environment 与实际不符 |
| npm 警告 "tokens that bypass 2FA are being restricted" | 正常提示，OIDC 不经过该路径 |

新建另一个包时，Trusted Publishing 只能在包首次发布之后配置：首个版本先用 token 或人工 OTP 发布，
再切到 OIDC。

### 3.7 用户侧升级

注册表安装的 bundle 会在插件详情页出现 **Versions** 区，用户显式点 Update。DSH 安装时按精确版本
保存（`saveExact`），不会自动升级。发布后不需要做别的动作；如果版本是破坏性的，在 Release Notes
和 CHANGELOG 里写清迁移步骤。

## 4. 市场收录（awesome-dsh-plugin）

市场条目在本仓库的 `market/LaoLiang-agent__HarnessKit.yml`，内容与
[awesome-dsh-plugin contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
对齐。首次收录：

1. 确认仓库 public、创建已满 1 天、有 `dsh-plugin` topic、根 `package.json` 声明 `dsh.bundle`。
2. fork `awesome-dsh-plugin/awesome-dsh-plugin`。
3. 把 `market/LaoLiang-agent__HarnessKit.yml` 复制为
   `data/plugins/LaoLiang-agent__HarnessKit.yml`（只加这一个文件）。
4. 提 PR，标题示例：`Add Harness Kit (LaoLiang-agent/HarnessKit)`。
5. CI 会检查条目数量、`dsh.bundle`、仓库年龄、awesome-lint 与站点构建；反馈以 PR 评论给出。

维护期更新条目：只改自己的 YAML 文件，不要手工改生成的 README。

条目规则要点（以后以 contributing.md 为准）：

- 描述只讲功能、必须与代码一致，英文以句号结尾；含 `: ` 时加引号。
- `category` 取自固定清单，本插件用 `workflow`。
- 图标可选，必须是 GitHub 托管的位图；不写则回退到作者头像。
- 截图已放在 `docs/assets/`，并在根目录 `screenshots.json` 声明（1–8 张相对路径），不要写进市场仓库。
  截图使用示例工作区（`acme-platform`）渲染，不含真实项目数据；界面改动后应重新生成并覆盖同名文件。
- 市场不会因为没发 npm 而拒绝收录，但发 npm 后能显示下载量、跳过 `allowBuilds`。

## 5. 兼容性与升级策略

- `engines.dsh` 是唯一兼容闸门：DSH 在安装/更新/启动时用它做 semver 判定（预发布版本参与范围）。
- 每次 DSH 新版本（尤其小版本到 0.3）先跑一遍：安装 → 冷启动 → `/hk-doctor` → 一个最小
  `/hk-fix` 任务 → 面板。通过后放宽 `engines.dsh` 并发布新版本。
- 不要为了省事删除 `engines.dsh`；插件在 Host 进程内运行，并用到了 `agent/created`、
  `subagent/model-selection-policy`、`webServer`、`workspaceRegistry` 等挂点，跨版本风险高。
- 用户显式授权兼容豁免（`dsh plugin allow-version`）时，风险由用户承担；不要主动建议。
- 废弃版本用 `npm deprecate dsh-harness-kit@<version> "<原因>"`，不要 unpublish；DSH 的更新列表
  会展示 deprecation 并拒绝安装该版本。

## 6. 回滚

- npm 版本不可复用：出问题发布新的 patch 版本，并 `npm deprecate` 有问题版本。
- 用户回滚：`dsh plugin --profile <profile> add dsh-harness-kit@<旧版本>`（等价于卸载重装）。
- 插件被禁用/卸载不会删除工作区 `.harness/`，用户资产安全；在 Issue 回复里明确这一点。

## 7. 本机开发安装（维护者日常）

```sh
dsh plugin --profile desktop add /Users/leo/Server/workspace/HarnessKit
```

`link:` 安装直接指向仓库，改 `kernel/` 后 toggle 插件开关即可重载；改 `client.js` 需刷新页面。
注意：`link:` 不会过滤 `files`，所以发版前必须再用 tarball 验证一次。

## 8. 支持与排查

- Issue 模板要求：DSH 版本、插件版本、OS、`/hk-doctor` 输出、复现步骤。
- 日志关键字：`harness-kit:`；面板端点：`/harness-kit/state`、`/harness-kit/config`、
  `/harness-kit/activity`、`/harness-kit/sync`、`/harness-kit/command`、`/harness-kit/env`。
- 常见问题：
  - 面板一直加载中 / 端点 404 → 冷启动路由未挂载或路由被旧 fiber 占用；完全重启 DSH。
  - 命令不可用 → 插件行被禁用或包未启用；检查 Plugins 页面。
  - Python 脚本失败 → `python3 --version`；`/hk-doctor` 会列出缺件并指引重跑 `/hk-init`。
