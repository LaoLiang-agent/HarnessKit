# Harness Kit

Multi-agent engineering workflow for DeepSeek Harness: seven roles, four flow profiles, human
approval gates, tool guards, a team-shareable workspace asset repository, and a Web task panel.

## What it does

- Adds ten `/hk-*` slash commands that drive a full engineering loop:
  setup → init → new → propose → apply → archive, plus fix, sync, test-environment lease and doctor.
- Registers seven roles from the bundled `ai-coding` pack. A project can override any role or flow
  file under `.harness/agents/` and `.harness/flows/` without changing plugin code.
- Enforces the workflow with tool guards: destructive git commands are blocked, and source writes are
  blocked while a task has no recorded human quality-gate verdict.
- Keeps project assets outside the plugin: `.harness/` holds deliverables, specs, memory, the task
  board, templates and rules, and can be bound to a team git repository.
- Routes logical model names (`reasoning`, `coding`, `fast` or a role name) to concrete
  provider/model pairs in `.harness/kit.json`.
- Adds a sidebar panel with task lanes, pending approvals and sync problems, team activity, and a
  configuration view.

## Requirements

- DeepSeek Harness 0.2.x with the Web client (the Desktop app or `dsh web`).
- `git` and `python3` on `PATH` (the workspace scripts are Python).
- A workspace directory opened as the DSH session working directory.

## Install

In DeepSeek Harness: **Plugins → Add plugin**, enter `dsh-harness-kit@0.1.0`, install, then enable
the bundle. From a terminal with DSH Desktop fully quit:

```sh
dsh plugin --profile desktop add dsh-harness-kit@0.1.0
```

Restart is only needed when replacing an already-installed version; a first installation normally
activates through hot reload.

## First run

1. `/hk-setup` — register the source repositories in `.harness/kit.json`, cloning any missing ones.
2. `/hk-init` — create the `.harness/` skeleton, materialize scripts/templates/rules, and optionally
   bind an asset repository (`--assets <url>`, `--assets init`, or `--assets local`).
3. `/hk-new <task> <description>` — bootstrap a task; then `/hk-propose`, `/hk-apply`,
   `/hk-archive` as the gates pass. For a small fix use `/hk-fix <task> <description>` instead.

Approval markers are written by a human. With `autoAdvance` enabled (default), the Host advances to
the next command after an approval is recorded and the task has a bound session.

## Compatibility and limits

- DSH `>=0.2.0 <0.3.0`; a DSH 0.3 release needs a new Harness Kit version.
- Web-only panel; the commands and guards work in any profile with the Host plugin loaded.
- The bundled `ai-coding` content pack is written in Chinese; role prompts and flows are plain files,
  so a project can override them.
- No MCP host support yet: this release targets DSH.
- No runtime npm dependencies and no install scripts.

## 中文

Harness Kit 是一个 DeepSeek Harness 插件，把多 Agent 工程流程装进 DSH：7 个角色、四档流程
（standard / quick / bugfix / refactor）、人工审批点、工具护栏、可共享的工作区资产仓库，以及一个
Web 任务面板。

命令：`/hk-setup` 登记代码仓库，`/hk-init` 初始化 `.harness/` 骨架与资产仓库绑定，
`/hk-new → /hk-propose → /hk-apply → /hk-archive` 走完整流程，`/hk-fix` 走轻量修复，
`/hk-sync` 同步团队资产，`/hk-te` 串行租用测试环境，`/hk-doctor` 体检。

要求：DSH 0.2.x（带 Web 客户端）、`git` 与 `python3`。项目资产保存在工作区 `.harness/` 下，
角色与流程可在 `.harness/agents/`、`.harness/flows/` 中按项目覆写，无需改插件代码。

安装：Plugins → Add plugin 输入 `dsh-harness-kit@0.1.0`；或退出 Desktop 后执行
`dsh plugin --profile desktop add dsh-harness-kit@0.1.0`。
兼容范围 `>=0.2.0 <0.3.0`，DSH 0.3 发布后需要新的插件版本。
