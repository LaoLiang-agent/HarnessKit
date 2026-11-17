# Harness Kit

A DeepSeek Harness (DSH) plugin that runs a multi-agent engineering workflow: roles, flow profiles,
human approval gates, tool guards, and a versioned workspace asset repository.

Harness Kit keeps the *method* (roles, flows, discipline, gates) separate from the *project assets*
(deliverables, specs, memory, task board). The method ships as a plugin; the assets live in the
user's workspace and can be versioned in git with the team.

## What it gives you

- **Seven built-in roles** (`packs/ai-coding/agents`): project manager (the session Lead), business
  analyst, solution architect, readiness reviewer, developer, code reviewer, test engineer.
  Project-level role overrides live in `.harness/agents/`.
- **Flow profiles** — `standard`, `quick`, `bugfix` and `refactor` YAML flows, plus a `new.yml`
  bootstrap flow and a `_router.yml` router. `/hk-fix` runs a lightweight fix path end to end.
- **Human approval gates** — approval 1 after the propose phase, approval 2 after the apply phase,
  and a quality-gate verdict that unlocks source changes.
- **Tool guards** — destructive git commands (`reset --hard`, `clean -f`, `push --force`) are blocked
  always; writes into source paths are blocked while an active task has no recorded quality-gate
  verdict.
- **Workspace assets** — `.harness/` holds deliverables, specs, memory, the task board, templates and
  rules. It can be bound to a team git repository (`/hk-init --assets <url>`), initialized as a new
  one (`--assets init`), or kept local.
- **Model routing** — logical model names (`reasoning`, `coding`, `fast`, or a role name) map to
  concrete `provider` / `model` pairs in `.harness/kit.json`; unresolved mappings fall back to the
  session default.
- **Web panel** — a sidebar panel with task lanes, an attention list (pending approvals, sync drift),
  team activity, task-to-session navigation, and a configuration view.
- **Concurrency helpers** — pooled git worktrees per source repository (`.worktrees/`) and a serial
  lease for the single test environment (`/hk-te`).

## Requirements

- DSH **0.2.x** with the Web client (Desktop app or `dsh web`); Node.js >= 24.9.0 (shipped with DSH).
- **git** and **Python 3** on `PATH`. `/hk-init` materializes Python scripts, and the task board
  writer, `/hk-doctor`, spec lint and verification run them.
- A workspace directory that DSH opens as the session working directory.

## Install

From npm (recommended):

```sh
dsh plugin --profile desktop add dsh-harness-kit@0.1.0
```

Run that with DSH Desktop fully quit, or install from the app: **Plugins → Add plugin**, enter
`dsh-harness-kit@0.1.0`, then enable the bundle. Replace `desktop` with your profile name for other
profiles (`dsh plugin --profile web add ...`).

From a checkout (development):

```sh
dsh plugin --profile desktop add /absolute/path/to/HarnessKit
```

The package declares `dsh.bundle.patch`, so installing it composes the `harness-kit` Host row and its
Web client half automatically.

## Quick start

1. Open the project workspace in a DSH session and run `/hk-setup` to register the source
   repositories in `.harness/kit.json` (it clones missing ones).
2. Run `/hk-init` to create the `.harness/` skeleton, materialize scripts, templates and rules, and
   optionally bind an asset repository. It is idempotent — re-run it after adding repositories.
3. Start a task with `/hk-new <task> <description>`, or go straight to `/hk-fix` for a small fix.
4. `/hk-propose <task>` runs the proposal phase; after approval 1, `/hk-apply <task>` runs the
   implementation phase; `/hk-archive <task>` archives the round and closes it.

Approval markers are written by a human, not by the plugin. When `autoAdvance` is enabled (default),
the Host advances to `/hk-propose` and `/hk-apply` once the corresponding human gate is recorded and
the task has a bound session; set `"autoAdvance": false` in `.harness/kit.json` to disable it.

## Commands

| Command | What it does |
|---|---|
| `/hk-setup [--add <git-url>]` | Collect source repositories into `kit.json.sources`; clone the missing ones |
| `/hk-init [--assets <url\|init\|local>] [--branch <name>]` | Create or refresh the `.harness/` skeleton and bind the asset repository |
| `/hk-new [<task>] <description> [--file <path>] [--auto]` | Bootstrap a full-flow task: proposal scaffold, clarification, profile selection |
| `/hk-propose [<task>]` | Run the propose phase (BA → SA → RR → approval 1) |
| `/hk-apply [<task>] [feedback]` | Run the apply phase (readiness precheck → Dev → CR → TE → approval 2) |
| `/hk-archive <task>` | Archive the round, run Spec/Memory merge and clear the active directory |
| `/hk-fix [<task>] <description> [--full\|--light] [--auto]` | Run the lightweight fix path end to end |
| `/hk-te [acquire\|release <task> \| status]` | Serial lease for the single test environment |
| `/hk-sync` | Commit → `pull --rebase` → merge append-only files → push the asset repository |
| `/hk-doctor` | Check workspace health: kit, roles, rules, flows, scripts, board and model mappings |

## Workspace layout

`/hk-init` creates the following under the workspace root:

```
.harness/
├── kit.json              # sources, models, assets binding, overlay mode, autoAdvance
├── deliverables/         # active task artifacts + _archive/ (incremental rounds)
├── specs/                # capability specs, appended per round
├── memory/               # entries/ one file per memory entry + index.md
├── tasks/                # board.md, per-machine state (sessions, claims, worktrees, test-env)
├── agents/ flows/        # optional project-level overrides
├── templates/ rules/     # materialized from the content pack
├── scripts/              # refreshed from the pack on every /hk-init (not committed)
└── codebase-guide/       # on-demand module documentation
```

## Configuration

`.harness/kit.json` is the project configuration:

```json
{
  "sources": [
    { "name": "backend", "url": "https://…/backend.git", "path": "services/backend", "role": "backend", "branch": "main" }
  ],
  "models": {
    "reasoning": { "provider": "deepseek", "model": "deepseek-reasoner" },
    "coding": { "provider": "deepseek", "model": "deepseek-chat" }
  },
  "assets": { "mode": "git", "remote": "https://…/harness-assets.git", "branch": "main", "autoSync": false },
  "autoAdvance": true
}
```

## The Web panel

With the Web client, a **Harness Kit** entry appears in the sidebar. It reads the workspace board and
shows planning / implementation / archive lanes, a "needs you" list for approvals and sync problems,
team activity from the asset repository, and a configuration view. Task cards can open the bound
session, start tasks, run `/hk-doctor` and archive finished work.

## Compatibility

- Declared DSH range: `>=0.2.0 <0.3.0`. DSH 0.3 will require a new Harness Kit release; the plugin
  refuses to install on a DSH release outside that range rather than failing at runtime.
- Plugin version `0.1.0`, first public release. Until 1.0, a minor version may contain breaking
  changes; see [CHANGELOG.md](CHANGELOG.md).
- No runtime npm dependencies and no install scripts.

## Development

```sh
npm test              # mock-agent regression suite (no DSH runtime needed)
npm pack --dry-run    # inspect the exact published file list
```

The regression suite covers commands, guards, the board format, sync, leases, worktrees and the panel
projection. Client code (`client.js`) and the visual panel still need a manual check in the Web GUI.

## License

MIT © 2026 leo. See [LICENSE](LICENSE).

## 中文简介

Harness Kit 是一个 DeepSeek Harness 插件，把多 Agent 工程流程（角色、流程档位、人工审批点、工具护栏、
工作区资产仓库）装进 DSH。内置 7 个角色与 `standard / quick / bugfix / refactor` 四档流程，
`/hk-setup → /hk-init → /hk-new → /hk-propose → /hk-apply → /hk-archive` 构成日常闭环，
`/hk-fix` 用于轻量修复。安装需要 git 和 Python 3；项目资产保存在工作区 `.harness/` 下，
可绑定团队 git 仓库共享。安装：`dsh plugin --profile desktop add dsh-harness-kit@0.1.0`，
或在 Plugins → Add plugin 中输入包名。DSH 兼容范围 `>=0.2.0 <0.3.0`。
