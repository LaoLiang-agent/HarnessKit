# Changelog

All notable changes to Harness Kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.1]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.1
[0.2.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.2.0
[0.1.6]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.6
[0.1.5]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.5
[0.1.4]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.4
[0.1.3]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.3
[0.1.2]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.2
[0.1.1]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.1
[0.1.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.0
