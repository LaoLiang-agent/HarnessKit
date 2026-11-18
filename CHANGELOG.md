# Changelog

All notable changes to Harness Kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.1
[0.1.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.0
