# 工程初始化多语言适配设计（最小侵入版）

- 状态：P0 已实现（2026-11-25）
- 适用：`packs/ai-coding` 的 `/hk-init` 初始化链路
- 版本：`0.3.2`（仅代码与文档，未改版本号、未发布）

---

## 1. 背景与结论

旧初始化只对 Java Maven、.NET、Vue、uni-app 有专用模板；其他技术栈在 `generate_plan` 阶段被直接 `continue`：

- 纯 Go / Python / React / Gradle 工程得到“未探测到子工程”的假结论；
- 混合仓库里这些子工程可能被 CodeGraph 索引，却没有 `AGENTS.md` / `build.json`；
- 初始化计划与完整性校验使用两套探测逻辑，结论互相矛盾；
- 前端 `compile` 为空、`build.json` 没有 `install`，导致编译验证天然空缺。

本设计的目标不是“给所有语言生成全套文档”，而是：

> **先保证不丢项目、命令可执行、入口文档标准；其余文档按档位生成。**

因此采用三档生成 + generic 兜底 + 可选 CodeGraph。

---

## 2. 目标与非目标

### 2.1 目标（P0）

1. 任何被 `kit.sources` 登记或 `services/` 发现的子工程都进计划，`summary.skipped` 恒为 0。
2. 未内置技术栈走 `generic` 模板，计划中明确 `needs_manual: true`。
3. 三档生成：
   - `minimal`：根 `AGENTS.md` + `.harness/build.json`
   - `standard`：+ `docs/CODE_STANDARDS.md`
   - `full`：+ 模块级 `AGENTS.md`
4. 专用模板默认 `standard`，generic 默认 `minimal`；`full` 显式选择。
5. `build.json` 增加 `install` / `lint`，并提供 `--write-build` 建议机制。
6. CodeGraph 默认不自动全局安装；缺失时只 WARN，可跳过。
7. 计划与完整性校验共用 `lib.enumerate_projects` / `lib.detect_project`。
8. `codebase-guide/overview.md` 自动写入确定性子工程地图（只改标记块）。
9. 已有 `AGENTS.md`/`CLAUDE.md` 的章节缺口进入计划；默认跳过，人可选择只追加修复。

### 2.2 非目标（后续）

- 专用模板已覆盖 Gradle、Node/React/Next/Nest、Go、Python、Rust；后续只做框架专属细化与模块级构建。
- 不做任意 monorepo 的模块级构建编排。
- 不自动猜测 `start-ok` / `start-port` 并当事实。
- 不改发布流程、不改版本号。
- `codebase-guide` 架构散文、已有 AGENTS 的自动重写留到 P1；缺口检测、子工程地图与根 AGENTS 同步已实现。

---

## 3. 三档模型

| 档位 | 生成物 | 默认适用 |
|---|---|---|
| `minimal` | 根 `AGENTS.md`（≤80 行）+ `.harness/build.json` | generic / unknown |
| `standard` | + `docs/CODE_STANDARDS.md`（≤80 行） | 有专用模板的已知栈 |
| `full` | + 模块级 `AGENTS.md` | 多模块长期维护工程，显式选择 |

档位来源：

1. `kit.sources[].tier` 显式指定；
2. 本次 `harness_init.py --tier minimal|standard|full` 全局覆盖；
3. 默认：`template_kind == dedicated` → standard；否则 minimal。

`full` 不自动启用；`--tier full` 只影响本次计划，不写回 `kit.json`。

模块状态仍会在计划中列出，但只有 `full` 档 `modules_enabled=true`；standard/minimal 不生成、校验器也不检查模块，避免“计划没生成、校验却报缺”。

---

## 4. 统一枚举

`lib.enumerate_projects(root)`：

1. 读 `.harness/kit.json` 的 `sources`；
2. 按 `source.path` 解析（相对工作区，拒绝 `..` 越界）；
3. 目录不存在 → `warnings`（`missing_source`），不加入 projects；
4. 再扫 `services/*` 直接子目录；
5. 以 `realpath + normcase` 去重，kit 优先；
6. 重名不丢弃，计划用 `path` 做唯一定位键。

这样解决：

- `kit.sources[].path` 支持 `services/team/foo`、`code/foo` 等自定义路径；
- 旧版只扫 `services/*` 一层导致“登记了但初始化看不到”；
- 缺失来源不再静默。

不在 `services/` 下递归找 git 仓库，避免把模块误当子工程。

---

## 5. 技术栈探测

`lib.detect_project(path, name, source)` 返回统一描述符。

### 5.1 类型

| 技术栈 | `service_type` |
|---|---|
| Java Maven 单/多模块 | `maven` / `maven-multimodule` |
| Java/Kotlin Gradle | `gradle` / `gradle-multimodule` |
| .NET（根或 `src/<Project>`） | `dotnet` |
| Vue 多 App / 单应用 | `vue-multimodule` / `mobile-app` |
| uni-app | `uniapp` |
| React/Angular/Svelte/Solid | `node-spa` |
| Next/Nuxt/Remix | `node-ssr` |
| Nest/Express/Fastify/Koa/Hono | `node-backend` |
| 其他 package.json | `node-generic` |
| Go | `go` |
| Python | `python` |
| Rust | `rust` |
| 其它/无法判定 | `unknown` |

判定顺序：Maven → Gradle → .NET → uni-app → package.json → Go → Python → Rust → unknown。

### 5.2 角色

- 后端标记：Maven/Gradle/.NET/Go/Python/Rust/Node 后端框架；
- 前端标记：SPA 依赖、`apps/`、uni-app、Blazor WASM；
- 两者并存 → `fullstack`；
- 只有前端且无 `apps/` → `mobile`；有 `apps/` → `frontend`；
- 只有 Node 后端 → `backend`；
- 否则 `unknown`。

角色只决定文档形态；技术栈细分由 `service_type` 承担。

### 5.3 描述符

```json
{
  "name": "go-api",
  "path": "services/go-api",
  "path_abs": "/ws/services/go-api",
  "source": "kit",
  "service_type": "go",
  "language": "go",
  "build_tool": "go",
  "framework": "go",
  "role": "backend",
  "template_dir": "generic",
  "template_kind": "generic",
  "supported": false,
  "needs_manual": true,
  "tier": "minimal",
  "modules": [],
  "codegraph": "MISSING",
  "warnings": [],
  "build_suggestion": {
    "compile": {"value": "go build ./...", "source": "go.mod", "confidence": "high"}
  }
}
```

`template_kind`：`dedicated | generic | override`。

---

## 6. 模块发现

| 类型 | 规则 |
|---|---|
| Maven | 优先解析根 `pom.xml` 的 `<module>`；回退顶层 `pom+src` / 扁平容器；支持嵌套相对路径 |
| .NET | 优先根 `*.sln` 项目行；回退递归 `*.csproj`（深度 ≤4，跳过 bin/obj/node_modules，排除 `*.Tests`）；`BlazorWebAssembly` 归前端模块 |
| Vue 多 App | `apps/*` 中含 `.vue` / `store` / `views` / `router` 的目录 |
| 其它 | 本轮不发现模块（后续专用模板再加） |

模块路径一律相对子工程根，`as_posix()`；不再硬编码 `services/<name>/...`。

模块记录：

```json
{
  "name": "Api",
  "path": "src/Api",
  "kind": "backend",
  "template": "dotnet/dotnet-multimodule/module-AGENTS.tmpl",
  "status": "MISSING",
  "meta_keys": ["domain"]
}
```

---

## 7. 模板解析

`lib.resolve_template(override, service_type)`：

1. `kit.sources[].template` 显式覆盖（只接受 `.harness/templates` 下存在的相对目录）；
2. `PREFERRED_TEMPLATE` 中登记且目录存在；
3. `generic`。

`PREFERRED_TEMPLATE` 可以预先登记未来模板；目录不存在时自动回落 generic，后续加模板不必改主流程。

### 7.1 generic 模板

新增模板：

```text
templates/
├── generic/              # 未内置栈兜底（minimal）
├── java/gradle/          # Gradle/Kotlin：root / module / CODE_STANDARDS / build
├── javascript/node-app/  # React/Angular/Next/Nest/Express：root / CODE / build
├── go/service/           # Go：root / CODE / build
├── python/service/       # Python：root / CODE / build
└── rust/service/         # Rust：root / CODE / build
```

`PREFERRED_TEMPLATE` 把 `gradle*` 映射到 `java/gradle`，把
`node-spa/node-ssr/node-backend/node-generic` 统一到 `javascript/node-app`；
模板提示词要求按实际框架写，不把 React 写成 Vue、不把 SPA 写成 SSR。
Gradle 多模块从 `settings.gradle(.kts)` 的 `include` 发现模块。

要点：

- 不写框架专属章节；
- 无法确认的写「未确认（需人工补充）」，允许保留 TODO；
- 与 `.harness/rules/code-standards.md` 冲突的现有写法标「待整改」，不得写成推荐；
- 优先引用 linter/formatter 配置，不复述格式规则。

### 7.2 已有模板

所有 `build.tmpl` 增加空的 `install` / `lint` 键；`compile/test` 等默认值保留，作为“未定制占位”。

---

## 8. 构建配置

### 8.1 字段

| 字段 | 说明 | 来源 |
|---|---|---|
| `install` | 依赖安装 | 建议 + 人确认 |
| `compile` | 编译/类型检查 | 模板/建议 + 人确认 |
| `test` | 测试 | 建议 + 人确认 |
| `lint` | 静态检查 | 建议 + 人确认 |
| `start` | 启动 | 人工确认 |
| `start-ok` | 启动判据正则 | 人工确认 |
| `start-timeout` | 超时秒数 | 模板默认 300 |
| `start-port` | 端口 | 人工确认 |
| `package` / `package-incr` | 打包 | 保留现状 |

空字符串 = 未声明 ≠ 通过。

### 8.2 推断

`lib.infer_build(project)` 按工程事实给出建议：

| 栈 | install | compile | test | lint |
|---|---|---|---|---|
| Maven | 空 | `./mvnw compile` / `mvn compile` | `./mvnw test` / `mvn test` | 空 |
| Gradle | 空 | `./gradlew build -x test` / `gradle ...` | `./gradlew test` | 空 |
| .NET | 空 | `dotnet build` | `dotnet test` | 空 |
| Node | 按包管理器 | `scripts.build` / `tsc --noEmit` | `scripts.test` | `scripts.lint` |
| Go | 空 | `go build ./...` | `go test ./...` | `go vet ./...` |
| Python | poetry/uv/pipenv/pip | `python -m compileall -q ...` | `pytest`（有证据） | `ruff check`（有配置） |
| Rust | 空 | `cargo build` | `cargo test` | `cargo clippy` |

Node 包管理器：`packageManager` → pnpm/yarn/bun/npm 锁文件 → npm。

`start` 只在明确无歧义时建议（唯一 .NET Web/Exe、唯一 `cmd/*/main.go`、`scripts.dev/start/serve`），不推断 `start-ok` / `start-port`。

### 8.3 `--write-build`

```bash
python3 .harness/scripts/harness_init.py --write-build <子工程|路径> \
  [--dry-run] [--keys install,compile,test,lint] [--keep-template-defaults]
```

行为：

- 不存在 build.json → 以模板为基底；
- 非法 JSON → exit 3，不写；
- 建议为空 → 跳过；
- 当前值为空 → 写入；
- 当前值等于模板默认值 → 视为未定制占位，可替换（如 `mvn compile` → `./mvnw compile`）；
- 人工改过的非默认值 → 保持；
- 原子写入，幂等；
- `--dry-run` 输出“当前 / 建议 / 来源 / 动作”。

### 8.4 执行入口

`run_field.FIELDS` 增加 `install`、`lint`；初始化编译验证先 install 再 compile。

---

## 9. CodeGraph

### 9.1 配置

`kit.json` 可选：

```json
{
  "codegraph": {
    "enabled": true,
    "pin": "^1.4.0"
  }
}
```

- `enabled=false`：初始化与 PM 前置检查都跳过；
- 子工程 `kit.sources[].codegraph=false` 跳过索引。

### 9.2 CLI

```bash
check_codegraph.py --all [--sync] [--optional] [--allow-install]
```

- 默认不自动安装；缺失时提示固定版本的安装命令；
- `--optional`：缺失/损坏/失败以 0 退出并打印 WARN；
- `--allow-install`：显式允许 `npm install -g @colbymchenry/codegraph@^1.4.0`；
- 初始化使用 `--sync --all --optional`，人确认后才加 `--allow-install`。

### 9.3 定位

CodeGraph 是**可选增强**，不是质量门：
- 无 Node/npm 的 Java/.NET 机器不受阻；
- 索引损坏只 WARN；
- 不因 CodeGraph 缺失伪造“已检查”。

---

## 10. 完整性校验

`codebase_guide_init.py` 改为 descriptor 驱动：

- 项目枚举与 `harness_init` 相同；
- 根文档章节由 `lib.doc_sections(service_type, role, template_kind)` 决定；
- generic/override 使用通用章节表，不拿专用模板标准要求；
- `minimal` 不检查 `CODE_STANDARDS.md`；`standard/full` 检查存在性；
- 模块只在 `full` 检查；
- 缺失根文档时生成对应骨架（generic/前端/fullstack），不覆盖已有文件；
- 输出按子工程分组，FAIL 非 0。

章节表：

| 条件 | 必需章节 |
|---|---|
| generic/override | Build、项目概述、目录结构、关键约定、参考文档 |
| backend 专用 | Build、项目概述、关键框架模式、关键约定、模块发现、参考文档 |
| frontend/mobile 专用 | Build、项目概述、目录结构、关键框架模式、关键约定、参考文档 |
| fullstack 专用 | 上述并集 |

---

## 11. 初始化流程

`init.yml` 的关键变化：

1. 探测阶段读 plan schema 2，展示 tier / template_kind / needs_manual / missing_sources；`skipped` 必须为 0。
2. 人确认时可选默认档位；需要 full 时用 `--tier full` 重新探测。
3. build.json 只拷贝模板；推断命令统一在“构建命令确认”阶段用 `--write-build --dry-run` 展示，人确认后写入。
4. 编译验证先 install，再 compile；空 compile = 未验证。
5. CODE_STANDARDS 仅 standard/full；模块文档仅 full。
6. CodeGraph 先 `--optional`，缺失时询问安装/跳过，不阻断。
7. 完整性校验使用同一枚举/分类，generic 也检查。

---

## 12. 根 AGENTS 与架构总览同步

### 12.1 根 AGENTS 子工程地图

`runInit` 首次创建根 `AGENTS.md` 时写入标记块：

```markdown
<!-- hk:sources:begin -->
| 名称 | 路径 | 角色 | 分支 |
...
<!-- hk:sources:end -->
```

`syncRootAgents(ws, kit, { create })`：

- 只替换标记块内表格，块外人工内容原样保留；
- `/hk-init` 用 `create: true`，可创建完整根文件；
- `/hk-setup --add` 用默认 `create: false`，只更新已有标记块，不生成半成品；
- 旧版 Harness Kit 生成（首行 `# 项目指南（Harness Kit 生成）`）→ 自动补标记并刷新地图；
- 其它无标记 AGENTS → 不改写，返回 `unmarked`，由初始化报告 warning；
- 只有 `CLAUDE.md`、没有 `AGENTS.md` → 不创建，返回 `legacy`；
- 子工程表路径直接取 `kit.sources[].path`，支持自定义路径。

同时修复：`addSource` 对“已登记且目录存在但不是 git 仓库”的路径不再重复写入一条 source。

### 12.2 codebase-guide/overview.md

`harness_init.py --write-overview [--tier ...] [--dry-run]`：

- 优先读 `.harness/.logs/workflow/harness-init-plan.json`（保留 init 确认时的 tier）；
- 写入 `<!-- hk:overview:begin/end -->` 标记块，列为：子工程、技术栈、构建工具、角色、档位、路径；
- 有标记 → 只替换块内，块外散文/人工内容保留；
- 无标记 → 追加独立章节（首次接管），不覆盖原文；
- 文件不存在 → 创建最小骨架 + 地图；
- 无子工程/缺失来源也如实写入；
- 重复执行内容不变则报「未变化」，不写盘。

该阶段只写机器事实，不生成架构散文；散文 TODO 仍由人/AI 补全。

### 12.3 已有 AGENTS 的章节缺口

- `harness_init --detect` 为已存在的入口文件计算 `root_files["AGENTS.md"].missing_sections`：
  按 `lib.doc_sections()` 的必需章节与 `## <section>` 子串比对；
- 初始化展示缺口，默认**跳过**；人可选择：
  - 只追加缺失章节：subagent 读现有文件 + 缺口清单 + 模板要求，只在文件末尾追加，
    输出到已存在的入口文件（AGENTS 优先；只有 CLAUDE 时追加 CLAUDE，不新建）；
  - 重新生成：必须二次明确确认，可能覆盖人工内容；
- `codebase_guide_init.py` 仍会 WARN 缺口，作为兜底检查；不自动改已有文件。

## 13. 兼容性

- Plan 增加 `schema=2`、`summary`、`missing_sources`、`tier`、`template_kind`、`modules_enabled`、`build_suggestion`；保留旧字段。
- `build.json` 新键可选；旧文件不迁移。
- 已有工作区重跑 `/hk-init`：脚本刷新、模板 create-only、generic 项目首次进入计划。
- 默认档位变化：已有专用模板项目默认 standard，模块文档需 full 才生成；已有模块文档不会被删除。
- Windows：路径 `as_posix()`；模板覆盖拒绝越界；命令包装器经 `_resolve_exe` 解析。

---

## 14. 文件改动

| 文件 | 改动 |
|---|---|
| `packs/ai-coding/assets/scripts/lib.py` | 枚举、探测、模板解析、模块、构建建议、CodeGraph opt-in |
| `packs/ai-coding/assets/scripts/harness_init.py` | plan v2、三档、generic、`--write-build`、`--write-overview` |
| `packs/ai-coding/assets/scripts/codebase_guide_init.py` | descriptor 驱动、generic 不跳过、tier 检查 |
| `packs/ai-coding/assets/scripts/check_codegraph.py` | `--optional` / `--allow-install`、配置、自定义路径 |
| `packs/ai-coding/assets/scripts/run_field.py` | `install` / `lint` |
| `packs/ai-coding/assets/scripts/verify.py` | Gradle/Python/Rust 构建兜底 |
| `packs/ai-coding/assets/templates/generic/*` | 新增 3 个模板 |
| `packs/ai-coding/assets/templates/**/build.tmpl` | 增加 install/lint 空键 |
| `packs/ai-coding/flows/init.yml` | 三档、构建确认、install 验证、overview 写入、CodeGraph 可选 |
| `packs/ai-coding/agents/project-manager.md` | CodeGraph 不自动安装 |
| `kernel/commands.js` | init 描述 |
| `README*.md` / `docs/DETAIL*.md` | 修正初始化承诺 |
| `test/sim.mjs` | 多语言 fixture、三档、build 建议、CodeGraph 可选、校验覆盖 |

---

## 15. 测试

`test/sim.mjs` 新增 fixture：

```text
services/
├── java/            Maven 多模块（专用模板 / standard）
├── dotnet/          src/Api/Api.csproj（嵌套模块）
├── vue/             apps/admin（Vue 多 App）
├── web/             React + pnpm（node-spa / generic / minimal）
├── nest/            @nestjs/core（node-backend）
├── go-api/          go.mod + cmd/server
├── py-api/          pyproject.toml
├── gradle-api/      settings.gradle
├── rust-api/        Cargo.toml
└── unknown/         src/Main.kt
code/custom/         自定义 path（kit.sources）
```

断言：

- `skipped=0`，所有项目进计划；
- generic/minimal 与专用/standard 的档位、root_files 正确；
- React/Gradle/Nest/Go/Python/Rust 不再静默跳过，且走各自专用模板；
- Gradle `include(":app")` 子项目被发现；
- .NET `src` 模块、Maven 顶层模块被发现；
- 自定义 path 与缺失来源可见；
- `--tier full` 生效但不写回；
- `--write-build` 识别 pnpm/scripts，且不覆盖人工非默认值；
- 根 AGENTS 标记块随 `addSource` 更新、块外人工内容不变；无标记旧文件不改写；
- CodeGraph 缺失时 `--optional` 只 WARN；
- 完整性校验覆盖 generic 项目；
- overview 标记块写入、人工内容保留、重复执行不改写；
- 已有 AGENTS 缺章节进入计划，Build 等已有章节不误报。

回归：`npm test`、`npm run pack:check`。

---

## 16. 后续（P1/P2）

1. 模块级构建配置（monorepo / 多 App）。
2. 生成物版本标记与漂移检查（`init --check`）。
3. 文档质量评估 fixture（命令真实、无编造、长度上限）。
4. React/Vue 的 App 级 AGENTS.md 模板与模块发现。

---

## 17. 验收

- [x] 未知技术栈不再消失，generic 明确标注
- [x] 三档生成，默认最小侵入
- [x] 自定义 path / 嵌套 .NET / Maven 顶层模块可见
- [x] build 建议可审计，人工值不被覆盖
- [x] CodeGraph 不自动全局安装，可跳过
- [x] 根 AGENTS 地图随 addSource 增量更新，不动人工内容；旧版 HK 文件可自动补标记
- [x] overview 子工程地图只改标记块，人工正文保留
- [x] 已有 AGENTS 缺口可见，默认跳过、只追加可选
- [x] Gradle/Node/Go/Python/Rust 专用模板生效
- [x] 校验与计划同源
- [x] 多语言 fixture 通过
- [x] 未改版本号、未打 tag、未 npm publish
