# Changelog

All notable changes to Harness Kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/LaoLiang-agent/HarnessKit/releases/tag/v0.1.0
