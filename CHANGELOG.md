# Changelog

All notable changes to Harness Kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- 飞书远程审批覆盖 DSH 工具权限弹窗（`approval/request`，例如 `danger-full-access` 或需要
  审批的 bash 操作）：权限原因和工具名会推送到飞书，可直接点「允许一次 / 拒绝」；与 DSH
  弹窗先答先得，飞书先答时 Web 卡片自动收起，「允许一次」只对本次操作生效。权限卡片默认
  10 分钟过期，可在 IM 设置里调整；超时按 fail-closed 返回 `unavailable`。

### Changed

- README / README.zh-CN 开头新增「在 DSH 中安装」：应用内 Add plugin、命令行、源码安装与
  直接建工作区的顺序；删除后文重复的安装章节，保留更新的版本检查与运行要求。
- README 补充面板「拉取 / 提交并同步」、`--base` 任务分支基点与 clean 主树自动切换、
  `/hk` 统一入口和 fix 直通说明；命令注册 hint 同步增加 `--base`。
- 立项说明同步当前界面：需求/快速修复、多参考材料、本机上传与按仓开发基线；DETAIL 同步；
  旧版立项截图替换为当前字段示意图，并从市场 `screenshots.json` 移除该示意图，市场只保留
  真实界面截图。
- `docs/PUBLISHING.md` 修正重复章节号，把本地 publish 段落改为 tag + CI 发布，并新增
  GitHub 协作者、main/tag ruleset、Actions 与 secret scanning 设置清单。
- 任务显式指定开发基线（`--base`）且主工作树干净时，即使当前停在 `test` 等非基线
  分支，`/hk-apply` 也会自动切到任务基线并创建任务分支；创建前先 fetch 该基线，
  本地基线只落后时直接用 `origin/<base>` 的最新提交，本地领先/分叉时保留本地基点。

### Fixed

- IM 配置变更（启用/停用、App ID/Secret、目标 Open ID）会在下一次提问时重建 bridge；
  旧实现只在首次创建时读配置，改了 Open ID 或先配置后启用会一直发到旧目标/一直不发，
  表现为「DSH 有决策弹窗、飞书没通知」。连接失败的 bridge 不再被缓存，下一次提问会重试。
- 飞书通知失败不再静默：未绑定目标 Open ID、连接失败、首张卡片发送失败会写入
  `.harness/local/im-audit.jsonl`（`notify-failed` / `connect-failed`），审批记录会显示
  错误摘要；配置步骤补充「IM 配置按机器/工作区本地保存，不随资产仓库同步」。
- 飞书测试消息成功后会提示「还需勾选启用」，设置页明确说明测试只验证凭据和目标
  Open ID，不代表审批推送已启用。
- 飞书「启用飞书审批通知」开关改为勾选/取消即保存，不再需要二次点击「保存飞书配置」；
  详情字段（App ID / Secret / Open ID）修改后仍由保存按钮提交。
- 飞书「获取 Open ID」遇到 `21001 Access denied due to platform policy` 时，错误信息会
  直接说明个人版租户不支持企业自建应用、需改用企业/团队租户，并附错误码；App ID/Secret
  或应用类型错误（10003/10013/10014）也会给出对应检查项。飞书配置步骤新增「个人版先用
  `admin.feishu.cn` 创建企业租户、切换后新建应用」的前置步骤。
- `/hk-apply` / `/hk-fix` 遇到主工作树分支占用时不再返回 DSH 命令注册表不支持的
  `decision` 结果（会话里只显示 `command "hk-apply" returned unknown result kind "decision"`）。
  改为标准 `error` 结果并在文本中列出可执行选项；面板仍从 `decisions.json` 还原可点按钮。

## [0.3.2] - 2026-11-25

### Added

- 资产同步拆成「拉取远端」和「提交并同步」：拉取只更新，不提交、不 push；提交并同步先
  预览待提交文件，可逐项勾选，标记疑似敏感/超大文件，只提交选中路径。
- 新增可选发版脚本 `scripts/release.sh`，固化版本校验、测试、bump、commit、tag、push；
  仍不执行 `npm publish`，发布只由 tag 触发的 CI 完成。

### Changed

- 飞书 SDK 预打包进 `kernel/im/vendor/feishu-sdk.cjs`，并改为 `devDependency`；发布包不再
  包含 `@larksuiteoapi/node-sdk` / `protobufjs` 运行时依赖，也不再触发 pnpm 的
  `ERR_PNPM_IGNORED_BUILDS` 构建审批。
- 面板只列出含 `.harness/kit.json` 的工作区，避免把普通目录误显示为 Harness 工作区。
- 在 `dsh-harness-kit` 仓库内，本地 `npm/pnpm/yarn publish` 会被护栏直接阻断；npm 发布
  只走 `vX.Y.Z` tag + CI。

### Fixed

- 面板「拉取远端」不再因为资产仓库有未提交改动而直接失败：改用
  `git pull --rebase --autostash` 暂存并在拉取后恢复本地改动；双方改同一文件时保留
  冲突标记和 autostash，返回可执行的解决指引，而不是误报成功或丢弃改动。
- 「提交并同步」只勾选部分文件时，未勾选的脏文件不再阻断 pull。

## [0.3.1] - 2026-11-25

### Fixed

- IM 启用后转发工作区内所有 `ask_user_question`，不再要求问题 id 或文本带 `HK:` / `hk-`
  前缀。旧任务里常见的 `finalize`、`q1-*` 审批现在也会发飞书卡片。
- HK 标记仅用于提取任务名和 `imDetail` 处理；普通 DSH 问题的 `detail` 保持原格式。

## [0.3.0] - 2026-11-25

### Added

- Feishu approval bridge for HK approvals and clarifications: the bot sends interactive cards to
  the configured private chat, supports option buttons, free-text questions and options that need
  supplementary text, and resolves the same `ask_user_question` request from either DSH or Feishu.
- Feishu settings in a dedicated IM tab: app ID/secret, one-click Open ID lookup, configuration
  guide, test message gating, and per-workspace config stored locally with `0600` permissions.
- Mobile-friendly cards: option text is shown in the card body and buttons use short numbered
  labels; `(Recommended)` is displayed as `（推荐）`.
- IM audit log with a 15-day default retention window (selectable 15/30/90 days) and an optional
  diagnostic view in settings.
- WeCom and DingTalk transport placeholders; Feishu is the first implemented channel.

### Changed

- DSH question dialogs keep their original `header / question / options` format. IM-only summaries
  use a separate `imDetail` field, which the bridge consumes and strips before the Web UI sees it.
- Answering in Feishu now ends the DSH question's lifetime, so the Web card closes after the answer.
- When DSH submits a multi-question batch after some questions were already answered in Feishu, the
  Feishu answers are merged per question (first answer per question wins).

### Fixed

- Feishu test messages work while the channel is disabled, and enabling is blocked until the test
  succeeds.
- Feishu answers no longer leave the DSH question card stuck on the first question; late or repeated
  Feishu card actions are ignored after the approval is settled.
- IM configuration no longer depends on a global whitelist; only the configured private-chat user
  can answer.

### Known limitation

- For one multi-question approval, finish on one surface. If DSH only records some answers and
  Feishu then completes the whole batch, DSH's local partial answers are not visible to the Host and
  cannot be merged; Feishu's complete batch wins. Split such decisions into separate
  `ask_user_question` calls when arbitrary per-question mixing is required.

## [0.2.5] - 2026-11-24

### Added

- New Task now supports multiple reference materials: pick several workspace files, reference a
  whole prototype folder, or upload files from the local machine. `/hk-new` accepts repeated
  `--file` arguments (quoted paths with spaces are supported) and copies everything into
  `.harness/deliverables/<task>/inputs/`.
- Each task gets an `inputs/INDEX.md` manifest with file types and sizes. Bootstrap reads text and
  prototype entry pages, opens images with `read_image`, and transfers visual/layout requirements
  into the proposal instead of only linking the files.
- Local uploads are staged under `.harness/local/staging/` (gitignored) and cleaned up after seven
  days; cancelling the dialog removes the current batch. Limits: 50 references per task, 300 files
  and 100 MB after expanding folders.

## [0.2.4] - 2026-11-23

### Added

- The panel checks npm for a newer Harness Kit version (one-hour success cache, three-second
  timeout, silent failure) and shows an update pill plus a dismissible banner. A plugin version
  section in Workspace settings shows current/latest versions. The plugin only prompts; updating
  remains an explicit action in Plugins → Harness Kit → Update.

### Fixed

- The New Task dialog no longer closes when clicking outside it. Only the explicit Cancel button
  dismisses the dialog, so a partially filled task is not lost by an accidental backdrop click.
- The plugin-version check no longer stays on "checking" when the Host route is unavailable or the
  request fails; it shows "check failed" and can be retried without affecting the plugin.
- `/hk close` now explains that a human acceptance of a BLOCK test report must be recorded as a
  separate formal `## 结论` PASS in `test-report.md` before archiving. PM instructions explicitly
  forbid bypassing close by manually copying the active deliverable directory into `_archive`.

## [0.2.3] - 2026-11-23

### Added

- `/hk-sync` now refuses to commit a mass deletion of core asset files (`specs/`, `memory/`,
  `tasks/`, `codebase-guide/`: 10+ files, or 3+ files above 5% of the repository), and refuses
  shallow/sparse asset checkouts. This prevents an incomplete local `.harness` clone from pushing
  deletions over the team repository, while normal `deliverables/` archive moves stay allowed. An
  explicit `/hk-sync --allow-deletions` is required for intentional bulk cleanup.
- `/hk-sync` now blocks when the local `.harness` branch does not match
  `kit.json.assets.branch`, preventing a `master` working tree from pushing its commits to `dev`
  (or the reverse).

## [0.2.2] - 2026-11-23

### Added

- Per-machine Worker model overrides in `.harness/local/models.json` (gitignored, never committed or
  synced). The panel's model editor now has separate `仅本机` and `团队默认` scopes, shows when a local
  entry shadows a team entry, and can copy team defaults before editing.
- Worker model resolution now takes a local override before the team mapping:
  local role > team role > local logical name > team logical name > session default.
  Subagent route authorization and `/hk doctor` also include local overrides.

### Changed

- The model-mapping section explains which file is written: local edits stay on this machine, while
  `团队默认` writes `kit.json` and is shared through the asset repository.

### Fixed

- New-workspace source repositories now require a branch in the wizard and the init API. Leaving it
  blank previously produced a misleading "initialized" state without the expected service clone.
  When an existing source is re-cloned without an explicit branch, the registered branch is used
  instead of the remote default branch.
- Workspace initialization now fails as a whole when an explicitly requested source cannot be cloned,
  instead of completing with only a warning and no frontend/backend entry in `kit.json`. The wizard
  also rejects a non-git directory left by an interrupted clone and asks the user to remove it first.
- Source and asset clones run with interactive Git credential prompts disabled, so a hidden Windows
  Credential Manager window can no longer leave initialization hanging. The panel also stops polling
  and reports a lost/stale initialization instead of showing "initializing" forever.

## [0.2.1] - 2026-11-22

### Added

- Historical tasks now have a run-record entry in the history board. Completed tasks read the
  archived `metrics/R<N>.json` snapshot first, so one PM session that handled several tasks does not
  mix their statistics. If no snapshot exists, the panel falls back to live sessions.
- Local development-config discovery now shows the complete candidate list in a scrollable area and
  lets you select files individually (`Sync selected`, `Sync all`, `Not now`). High-confidence files
  are preselected; ordinary config files are opt-in.

### Changed

- The local-config section uses plain language (本机开发配置) and explains that these files stay on
  this machine, are not committed, and are copied into new parallel workspaces. Internal terms such
  as `git-ignored`, `candidate`, `manifest` and `slot` are no longer shown in the main UI.
- Run records no longer display a raw tool-failure count; the snapshot still keeps `toolFailures`
  for diagnostics, but the user-facing summary/table shows only model, turns, tokens and duration.

### Fixed

- `POST /harness-kit/local` could return "未知工作区" because the old handler only read `workspace`
  from the query string while the client sent it in the request body. The server now reads the body
  (and the client also sends the query parameter for compatibility with a not-yet-reloaded Host).
- Local-config sync feedback is truncated to three notes for large file lists instead of producing
  an unreadably long toast.

## [0.2.0] - 2026-11-22

### Added

- Unified `/hk` entry with four daily verbs: `init`, `task` (`--fix`), `close`, and `doctor`
  (`--fix`). Existing `/hk-*` commands remain available as advanced aliases.
- Zero-touch closeout: `kit.json.worktree.autoClose` (default on for new workspaces) makes
  `/hk close` synchronize the target branch, merge a clean task branch locally, release the slot and
  delete the merged task branch. `targetSync` defaults to `safe` (fast-forward behind, keep when
  ahead, clean local merge when diverged); `ff-only` and `off` are available for stricter setups.
  Conflicts, a dirty target, or a diverged target stop before archiving and leave the task active.
  `--no-merge` keeps the old archive-only behavior; `--dry-run` previews the plan. Nothing is pushed.
- Archived tasks now include a per-round run snapshot at
  `.harness/deliverables/_archive/<task>/metrics/R<N>.json` with provider, model, reasoning effort,
  turns, token components, active duration and tool failures. A live "run record" view in the panel
  uses the same collector. No prompts, message bodies or raw session ids are stored.
- Machine-local state now lives under `.harness/local/` (sessions, worktrees, decisions, test lease,
  local-file approvals, auto-advance marks) and is ignored as one directory. Legacy `tasks/*.json`
  files migrate automatically.
- `/hk-doctor --fix` repairs deterministic gaps: refreshes scripts/templates, normalizes the board,
  rebuilds memory indexes and migrates legacy config. The panel can discover, approve and provision
  git-ignored local config files without using `/hk-local`.

### Changed

- Init templates are named `root-AGENTS.tmpl`, `module-AGENTS.tmpl` and `app-AGENTS.tmpl`; old
  `*-CLAUDE.tmpl` names remain a read-only fallback for existing workspaces. Init gaps are returned
  as structured items (kind/repo/path/action) instead of only display strings.
- Panel terminology now uses 流程 (flow), 方案审批 / 交付审批 and 快速修复; the settings view is
  labelled 工作区 and team activity is labelled 团队. Worker model mappings are marked advanced.
- Four-column legacy boards are migrated to the seven-column contract by the repair script.

### Fixed

- A task branch could be merged into a stale local target because closeout did not update the target
  first; target sync and already-merged detection now run before the merge.
- Merged task branches are deleted even when the main worktree is on another branch; conflicts fail
  before archive documents are cleared.
- Local-file approvals and session history survive across task rounds; session bindings keep history
  so multi-session tasks can be summarized.

## [0.1.6] - 2026-11-22

### Fixed

- Slot allocation can discover git-ignored local config candidates from the main worktree and copy
  or symlink only human-approved files into new/reused slots. Approvals live in the local
  `tasks/local-files.json` manifest; new candidates only prompt via `/hk-local`, with no hardcoded
  project filenames. Existing target files are never overwritten. `sources[].localFiles` remains a
  simple team baseline.
- `/hk-archive` can now auto-merge clean task branches locally when
  `kit.json.worktree.autoMergeClean` is true. It only merges locally, never pushes; conflicts or an
  unusable target still stop for human action. Default remains off.
- Init treats `AGENTS.md` and `CLAUDE.md` as equivalent entry files for the workspace root and
  subprojects: if either exists, the missing one is not generated; if neither exists, only
  `AGENTS.md` is generated. Existing `CLAUDE.md` files are left untouched. Roles, init checks,
  verify and the panel gap check read either name.
- Added `.harness/scripts/te_lease.py`: the PM can acquire/release the TE lease through bash, using
  the same `tasks/test-env.json` as `/hk-te`, so the TE gate no longer requires a human to run a
  slash command. The lease remains a serial resource lock, not an approval.

## [0.1.5] - 2026-11-20

### Added

- Worker model bindings in the settings page now include a reasoning-effort selector. Options come from
  the selected model's DSH capability metadata (`resolveModelInfo`), not a hard-coded universal list:
  DeepSeek exposes `off/low/high/max`, other providers may expose `minimal/low/medium/high` or none.
  New bindings default to `low` when the model supports it; otherwise they fall back to the model's own
  default. Models with no reasoning metadata show only "默认".
- Memory assets now use hot/cold routing indexes. `memory/index.md` is the default hot index;
  `memory/cold.md` is searchable on demand and is never auto-deleted. `memory_index.py` regenerates
  both from entry frontmatter, records use with `touch`, promotes entries back to hot, and supports
  `cool --days N --apply` plus `check`. Archive instructions run sync/cool/check after Memory Merge.

### Fixed

- The Worker model-mapping provider dropdown lists only currently registered providers. A mapping that
  points at a provider no longer available shows an inline warning and blocks saving instead of adding a
  fake option to the dropdown.

### Changed

- Reduced orchestration noise: `update_board.py` is written only at stage boundaries, related
  `git status`/`log`/`branch`/`ls` commands are merged into one bash call, and logs are read as failure
  summaries. PM heartbeat frequency is unchanged.

## [0.1.4] - 2026-11-19

### Changed

- Added a stage handoff (`handoff.md`) as the primary context passed between roles. `/hk-new` scaffolds
  it, `/hk-init` materializes the template, and every worker reads the handoff plus only the sections it
  lists instead of re-reading whole requirements/design/spec files.
- Added a sub-agent wait discipline to the PM role and every compiled dispatch appendix: prefer the
  completion notice, wait at most once with a long timeout, and never poll every five minutes or ask
  for progress with `send_message`.
- Added a context-read budget: locate sections with `grep` before reading, use `read` offsets for large
  files, read each file once per round, and keep only failure summaries from tool output.

## [0.1.3] - 2026-11-19

### Fixed

- Archived tasks no longer leave a permanent worktree-ledger entry when their task branch is merged
  after archive, or when the main worktree is switched to `dev`/`test` before the next archive. The
  ledger is reconciled on `apply` / `new` / `fix` / `archive` / `sync` / `doctor`: merged or missing
  task branches release the entry without changing the current branch; unmerged or dirty worktrees
  stay bound and are reported as stale.
- The panel now surfaces an archived task whose worktree ledger is still bound, with a one-click
  `/hk-archive <task>` action.

## [0.1.2] - 2026-11-19

### Fixed

- Panel HTTP routes now apply DSH Connection's Host/Origin and browser-session check through
  `ctx.connection.requestRejection(req)` before any handler runs. Requests from another web page
  receive `401` / `403` instead of reaching workspace state, filesystem browsing, git operations or
  `/hk-*` command execution.
- The Host now hard-depends on the `connection` service for the panel routes. If a composition has a
  web server but no Connection, the routes are not mounted (fail closed) instead of serving
  owner-private data unauthenticated.

## [0.1.1] - 2026-11-18

### Added

- Workflow mode (`applyMode`: auto / review) in the config view, stored in `kit.json`; `/hk-init`
  migrates the old `.harness/config.json`, and the mainline branch is derived per repository from
  `build.json` > `kit.sources[].branch` > `dev`.
- Session-level workspace attention dock above the composer and a sidebar alert dot, so blocking
  workspace issues (worktree decisions, sync drift, pending archive, incomplete init) are visible
  without opening the plugin.

### Fixed

- Apply now creates and checks out the task branch from the selected development baseline when the
  main worktree is clean on the registered baseline, instead of stopping with a "still on dev"
  workspace decision. Foreign branches and dirty worktrees still require a human decision.
  Task branches are created with `--no-track`, so a push cannot land on the base branch by accident.
  The task dialog now labels the selector **开发基线** and explains that it creates
  `feat/harness-<task>` and is the archive merge target.
- Archive release returns the main worktree to a local base branch instead of a detached HEAD when
  the task base is a remote-tracking branch.

### Changed

- Approval 1, approval 2 and the fix quality gate now require a visible approval message with
  Markdown links to the round's artifacts; the `ask_user_question` text carries the same links, and
  the flow compiler enforces the rule for project-defined flows as well.

## [0.1.0] - 2026-11-17

First public release.

### Added

- DSH bundle (`dsh.bundle.patch`) with one Host row (`harness-kit`) and a Web client half.
- Ten `/hk-*` commands: setup, init, new, propose, apply, archive, fix, te, sync, doctor.
- Bundled `ai-coding` content pack: seven roles, standard / quick / bugfix / refactor flows, a
  bootstrap flow and a profile router, templates (dotnet / java / javascript), coding standards and
  the Python workspace scripts.
- Workspace asset management under `.harness/`: kit configuration, deliverables, specs, memory,
  task board, codebase guide, project-level role/flow overrides.
- Asset repository binding (`--assets <url|init|local>`) and git sync with append-only auto-merge
  and conflict rollback.
- Logical model routing (role or flow stage → `provider` / `model`), with automatic subagent model
  authorization for mapped routes.
- Tool guards: destructive git command blocking, source write blocking before the quality-gate
  verdict.
- Web sidebar panel: task lanes, attention list, team activity, configuration view, task-to-session
  navigation.
- Auto-advance of the deterministic gates, task-to-session binding, task claims, pooled git
  worktrees and a serial test-environment lease.
- Environment preflight in the new-workspace wizard: checks `git` and `Python 3`, and shows the
  install command and documentation link for the current platform when either is missing.
- Documentation: Chinese README (`README.zh-CN.md`), English README, and per-language plugin detail
  documents (`docs/DETAIL.md`, `docs/DETAIL.en.md`).
- Screenshots of the war-room panel, the new-workspace wizard and the task dialog, rendered from a
  sample workspace; declared in `screenshots.json` for marketplace storefronts.

[0.3.2]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.3.2
[0.3.1]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.3.1
[0.3.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.3.0
[0.2.5]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.5
[0.2.4]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.4
[0.2.3]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.3
[0.2.2]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.2
[0.2.1]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.1
[0.2.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.0
[0.1.6]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.6
[0.1.5]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.5
[0.1.4]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.4
[0.1.3]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.3
[0.1.2]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.2
[0.1.1]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.1
[0.1.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.0

