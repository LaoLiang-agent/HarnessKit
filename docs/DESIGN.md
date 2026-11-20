# Harness Kit 插件设计文档

> 版本：v0.2（开放问题已裁决，可进入 M1 实现）
> 日期：2026-11-09
> 状态：评审通过
>
> **仓库位置（2026-11-12 起）**：插件代码迁出 iot-harness，独立维护于 `/Users/leo/Server/workspace/HarnessKit/`（本文档在 `docs/` 下）；DSH profile 经 `link:` 依赖指向该目录（0.1.0 起对外包名为 `dsh-harness-kit`）。iot-harness 仅保留工作区资产（`.harness/`、AGENTS.md 等），不再含插件代码。

---

## 1. 产品定位

Harness Kit 是一个 **领域无关的多 Agent 工作流运行时**，以 DSH 插件形态交付。它把"方法论"（角色、流程、纪律、工具）与"项目资产"（交付物、规格、记忆、任务）分离：

- **换领域 = 换内容包，不动内核**。当前 AI Coding Harness（PM/BA/SA/RR/Dev/CR/TE + 四 Profile）只是内核自带的默认内容包；用户可以定义新角色、新流程，把它变成面向项目交付、运维、研究等任意领域的 Harness。
- **一份资产，多端宿主**。内容资产格式中立，DSH 是一个宿主，MCP bundle 是另一个宿主（兼容 WorkBuddy、Claude Code 等支持 MCP 的 Agent 产品）。

### 1.1 核心设计目标

| # | 目标 | 验收标准 |
|---|---|---|
| G1 | 公共能力插件化 | Agent 角色、流程、skills、脚本、护栏、模板随插件分发，版本化升级 |
| G2 | 用户可自定义角色与流程 | 用户在工作区增删改角色/流程文件即生效，无需重写插件代码 |
| G3 | 项目资产工作区沉淀 | deliverables / memory / specs / tasks 在用户工作区创建与演进，跟随项目 |
| G4 | 团队资产 git 共享 | 支持绑定已有 git 仓库（clone）或新建空仓库（init + push） |
| G5 | 异构模型调度 | 流程中不同角色可使用不同 provider/model |
| G6 | 多宿主兼容 | 脚本与内容资产可通过 MCP 被 WorkBuddy / Claude Code 复用 |

---

## 2. 总体架构：三层模型

```
┌────────────────────────────────────────────────────────┐
│ 内容包层（Content Pack，可替换、可分发）                  │
│  · agents/    角色定义（MD + frontmatter）               │
│  · flows/     流程定义（YAML：阶段、角色、审批点、模型）    │
│  · skills/    按需加载技能（SKILL.md 格式）               │
│  · templates/ 文档模板（proposal / spec / memory 等）     │
│  · 默认包：ai-coding（当前 harness 工程抽取）             │
├────────────────────────────────────────────────────────┤
│ 运行时内核层（Kernel，DSH 插件本体，领域无关）            │
│  · 角色注册器  内容包/工作区角色 → DSH preset / 派发配置  │
│  · 流程引擎    流程 YAML → Lead 编排指令 + 状态机         │
│  · 命令集      /hk-init /hk-new /hk-propose /hk-apply …  │
│  · 护栏集      ToolGuard：写禁区、质量门、审批强制         │
│  · 资产管理器  工作区 .harness 目录脚手架 + git 同步       │
│  · 脚本工具集  verify / archive / merge（子进程或原生工具）│
│  · 模型路由    逻辑模型名 → provider/model 解析           │
├────────────────────────────────────────────────────────┤
│ 项目资产层（Project Assets，用户工作区，跟随项目演进）     │
│  · .harness/deliverables/  任务交付物（活目录 + _archive）│
│  · .harness/specs/         能力规格（Spec Merge 沉淀）    │
│  · .harness/memory/        踩坑记忆（Memory Merge 沉淀）  │
│  · .harness/tasks/         任务板                         │
│  · .harness/agents|flows/  项目级角色/流程覆写（可选）     │
│  · .harness/kit.json       项目配置（内容包、git 远端）   │
│  · 可绑定团队 git 仓库作为共享源                           │
└────────────────────────────────────────────────────────┘
```

### 2.1 资产解析顺序（合并规则）

同一逻辑资产（角色、流程、skill、模板）按以下优先级解析，高优先级整体覆盖低优先级：

```
项目工作区覆写  >  用户级覆写（$DSH_HOME/harness-kit/）  >  启用的内容包  >  内核默认值
.harness/agents/    $DSH_HOME/harness-kit/agents/         <pack>/agents/      （内置 ai-coding）
```

- 项目级覆写文件**不存在时**：init 时从内容包拷贝一份作为可改起点，或直接引用内容包版本（由 `kit.json` 的 `overlay.mode: copy | reference` 决定，默认 `reference`，避免无谓复制）。
- 删除项目级覆写文件 = 回落到内容包版本；内容包提供 `disabled: true` frontmatter 字段支持"显式禁用某角色"。

---

## 3. 内容包格式规范（格式中立）

所有内容资产为纯 Markdown / YAML，不含任何 DSH 专有语法。DSH 宿主和 MCP 宿主各自实现薄薄的适配层。

### 3.1 角色定义 `agents/<role>.md`

```markdown
---
role: solution-architect          # 唯一标识，kebab-case
name: 方案架构师
description: 负责技术方案设计，产出 solution.md
model: reasoning                  # 逻辑模型名（见 §6），可省略 = 会话默认
tools: [read, grep, glob, bash]   # 角色可用工具白名单，可省略 = 继承宿主默认
write_scopes: [.harness/deliverables/]   # 建议写范围（映射为 Team write_scopes）
---

# 身份与职责
（角色系统提示词正文，Markdown 自由格式）

# 产出契约
- 输出文件：deliverables/<任务>/solution.md
- 完成标准：……
```

### 3.2 流程定义 `flows/<flow>.yml`

```yaml
flow: standard                    # 流程 id
name: 标准开发流程
description: 新功能开发：BA → SA → RR → 审批1 → Dev → CR → TE → 审批2 → 归档

stages:
  - id: propose
    approval: after               # 阶段完成后需人工审批（审批点 1）
    workers:
      - role: business-analyst
        artifact: requirements.md
      - role: solution-architect
        artifact: solution.md
        after: [business-analyst] # 阶段内依赖
      - role: readiness-reviewer
        artifact: ready-check.md
        after: [solution-architect]

  - id: apply
    approval: after               # 审批点 2
    workers:
      - role: developer
        tdd: true
      - role: code-reviewer
        after: [developer]
        gate:                     # 质量门：CR PASS 才放行
          script: scripts/gates/cr_pass.py
      - role: test-engineer
        after: [code-reviewer]
        model: fast               # 阶段级模型覆盖（优先级 > 角色级 > 会话默认）

  - id: archive
    script: scripts/archive.py    # 纯脚本阶段，无 worker
    approval: before              # 执行前确认
```

流转判定表（bugfix / quick / refactor 等 Profile 选择逻辑）也表达为 YAML：

```yaml
# flows/_router.yml
routes:
  - when: "修复已知缺陷且影响面单一且核心改动 ≤2 文件且无新增 API"
    flow: bugfix
  - when: "跨模块变更"
    flow: refactor
  default: standard
```

> 路由的 `when` 是自然语言判定条件，由 Lead（PM 身份）在 bootstrap 阶段解读并与用户确认——保持当前 harness「AI 判定 + 人裁决」的语义，不做成硬编码规则引擎。

### 3.3 skills `skills/<name>/SKILL.md`

直接采用 DSH / Claude Code 通用的 skill 格式（frontmatter: `name`、`description`、`whenToUse`），DSH 宿主可零适配挂载（`dsh-skill-filesystem` 原生扫描）。

### 3.4 模板 `templates/`

proposal.md、bugfix.md、spec-template.md、memory 条目模板等，纯文本占位符（`{{task}}`、`{{date}}`），init 时由资产管理器填充。

---

## 4. DSH 宿主实现映射

| 内核模块 | DSH 机制 | 关键 API / 包 |
|---|---|---|
| 角色注册器 | 读取内容包+工作区角色文件，动态注册 preset | `ctx.agentPresets.register(definition)`；preset 声明 = `dsh-agent-preset` 行，可被 bundle patch 覆写 |
| 流程引擎 | Lead 编排提示词注入 + Agent Teams 执行 | `spawn_teammate` / `subagent` / `team_task_*`；流程 YAML 编译为 Lead 系统提示词段落 |
| 命令集 | 原生斜杠命令 | `ctx.commands.register()`（`dsh-commands`）；命令切状态 + 注入提示驱动模型（plan-mode 模式） |
| 护栏集 | 工具护栏 | `ctx.tools.guard()` 同步护栏（写禁区、质量门拦截），`tools/pre-execute` allow/deny/ask |
| skills | 文件系统 skill 提供者 | `dsh-skill-filesystem`：项目根 `.dsh/skills` 符号链接/复制 + `bundledSkillDir` 默认包；watch 热加载 |
| 脚本工具 | 子进程调用 或 原生工具 | `ctx.subprocess.spawn` 跑 Python；高频脚本用 `defineTool` 包成原生工具（校验参数、结构化输出） |
| 资产管理 | 工作区文件读写 | `ctx.fs`（workspace-write 沙箱内）；git 操作走 subprocess（需审批） |
| 模型路由 | 派发参数 | `subagent` 的 `provider/model/reasoning_effort`；`workflow` phase 级覆盖；`list_subagent_models` 校验可用性 |
| 审批交互 | 结构化提问 | `ask_user_question`（质量门裁决、审批 1/2） |
| 长任务 | 跨轮目标 | `create_goal`（propose/apply 长流程跨轮续跑） |
| 可视化（可选增强） | Client 插件 | Slots 注册任务板/流程进度面板（后续里程碑） |

### 4.1 命令集设计

| 命令 | 作用 | 对应原 harness |
|---|---|---|
| `/hk-setup [--add <url>]` | 第 0 阶段工作区搭建：收集/clone 代码仓库，登记 kit.json sources（§7.0） | 新增（原为手工隐式步骤） |
| `/hk-init` | 工作区初始化：探测 sources、生成 `.harness/` 骨架、绑定资产 git 仓库、选择内容包 | harness-init |
| `/hk-new <任务> <描述>` | 启动新任务：脚手架 deliverables 目录 + 打磨 proposal | harness-bootstrap |
| `/hk-propose <任务>` | 执行流程 propose 阶段 | harness-propose |
| `/hk-apply <任务> [反馈]` | 执行 apply 阶段（支持 review 模式续接） | harness-apply |
| `/hk-archive <任务>` | 归档：Spec/Memory Merge + 收档 + 清活目录 | harness-archive |
| `/hk-fix <任务> <描述>` | 缺陷直通流程 | harness-fix |
| `/hk-sync` | 资产 git 同步（pull --rebase + push） | 新增 |
| `/hk-doctor` | 环境自检：内容包完整性、脚本依赖、git 状态 | check_harness |

> 命令名前缀 `hk-` 避免与其他插件冲突；同时保留自然语言入口（"我要做一个新任务：…"），由 Lead 提示词识别。

### 4.2 角色派发策略

- **PM**：不另起 agent，由当前会话 Lead 承担（编排提示词内嵌 PM 角色定义全文），模型跟随会话 preset。
- **异构模型 / 一次性角色**（BA/SA/RR/Dev/CR/TE）：`subagent` 派发，携带解析后的 `provider/model`。流程引擎在派发前完成模型解析（§6），并用 `list_subagent_models` 预校验，不可用时降级到会话默认并提示用户。
- **批量扇出**（如 CR 分文件并行审查）：`workflow` 脚本，phase 级模型覆盖。

### 4.3 护栏移植

原 `.claude/hooks/`（pre_bash / pre_edit / dev_gate）用 JS 重实现为 ToolGuard：

- **写禁区**：bootstrap 阶段禁止写 `services/`、`e2e/`——guard 检查 write/edit 目标路径前缀，命中即返回拒绝 reason。同步纯函数，无子进程。
- **质量门**：fix 流程归档前检查 `bugfix.md` 是否含已裁决的质量门记录（读文件 + 正则， guard 内允许同步 fs 读；若需异步则改用 `tools/pre-execute` 事件链）。
- **危险命令拦截**：`reset --hard`、越界 `rm` 等，对 bash 命令文本做模式匹配。

---

## 5. MCP 宿主（WorkBuddy / Claude Code 兼容）

内核中**脚本工具集 + 内容资产**打包为独立 MCP server（`harness-kit-mcp`）：

- **Tools**：`hk_init_task`、`hk_archive`、`hk_verify`、`hk_spec_merge`、`hk_memory_merge`、`hk_sync` 等，内部调用同一套 Python 脚本。
- **Resources**：角色定义、流程定义、模板以 MCP Resource 暴露，宿主 Agent 可读取后自行编排。
- **格式适配器**：WorkBuddy 的"专家/技能"、Claude Code 的 subagent/skill 各自有 frontmatter 方言，适配器负责字段映射（内容本体不变）。

边界声明：commands、ToolGuard、preset 注册、GUI 面板为 **DSH 专有能力**，MCP 宿主上退化为"脚本工具 + 文档资产"，流程编排由宿主自身的 Agent 能力承担。

---

## 6. 模型抽象层

内容包只写**逻辑模型名**，宿主负责映射，保证内容包跨环境可移植：

```yaml
# kit.json（项目级）或插件配置（全局默认）
models:
  reasoning: { provider: deepseek, model: deepseek-reasoner }
  coding:    { provider: deepseek, model: k3-256k }
  fast:      { provider: deepseek, model: k3 }
  # 用户可指向任何已配置的 provider
```

解析优先级：**流程阶段 `model:` > 角色 frontmatter `model:` > 内容包默认 > 会话默认模型**。

派发前用 `list_subagent_models` 校验；映射缺失或模型不可用时降级会话默认并告知用户。

---

## 7. 工作区搭建、项目资产与 git 同步

### 7.0 首次使用流程：`/hk-setup` 工作区搭建

AI Coding 场景存在三类生命周期不同的对象，必须拆成两个命令、两个阶段：

| 对象 | 性质 | 频率 | 归属 |
|---|---|---|---|
| 代码仓库（backend/frontend/app…） | 项目源代码，每人每机 clone 一次，日常开发演进 | 一次性 + 偶尔新增端 | 个人本地 |
| harness 资产仓库 | 团队共享的 specs/memory/deliverables | 一次性绑定 + 持续同步 | 团队 |
| init 探测/索引 | 从已有代码仓库生成 build.json、代码索引、宿主指令文件（§7.4） | 可反复重跑 | 本地 |

**首次使用完整流程**：

```
/hk-setup                        ← 第 0 阶段：工作区搭建
  ├─ 确认/创建工作区根目录（DSH 会话 cwd）
  ├─ 逐个收集代码仓库：名称、URL、分支、本地路径、角色（backend/frontend/app）
  │    ├─ 路径已存在 → 跳过 clone，登记即可（兼容手工 clone 过的老用户）
  │    └─ 不存在 → git clone（默认普通 clone，见下方裁决）
  └─ 仓库清单写入 kit.json 的 sources: 段

/hk-init                         ← 第 1 阶段：harness 初始化
  ├─ 从 kit.json.sources 探测子工程（兜底：扫 services/ 目录）
  ├─ 生成 .harness/ 骨架、build.json、codebase-guide 索引、宿主指令文件（§7.4）
  ├─ 资产仓库绑定三情形（见 §7.2）
  └─ 选择内容包、模型映射

之后：/hk-new → /hk-propose → /hk-apply → /hk-archive（日常循环）
```

**拆分理由**：

1. **幂等性不同**：init 必须可安全重跑（新增端、索引过期），重跑时绝不触碰代码 clone；setup 严格一次。
2. **失败域不同**：代码仓库与资产仓库可能是不同 git 服务器、不同 VPN/权限，分开排错。
3. **人员场景不同**：老员工本机已有 clone，setup 只是登记路径；新员工才走完整 clone。

**演进场景**：

- 新增端：`/hk-setup --add <url>` 补 clone + 更新清单，再重跑 `/hk-init` 重新探测（衔接"新增端自动纳入"红线）。
- 非 coding 领域：`/hk-setup` 是**内容包提供的钩子**，非内核硬编码。ai-coding 包声明"收集代码仓库清单"；项目交付包可声明"收集文档目录"。内核只提供交互框架与 kit.json 落盘。

**clone 方式裁决（已定）**：默认**普通 clone** + kit.json 记录分支/基线（各仓库独立操作顺滑）；`git submodule` 作为 setup 时可选项保留。

**kit.json sources 段示例**：

```json
{
  "sources": [
    { "name": "backend",  "url": "http://…/sie-iiot.git",      "path": "services/backend",  "role": "backend",  "branch": "master" },
    { "name": "frontend", "url": "http://…/sie-iot-web-new.git", "path": "services/frontend", "role": "frontend", "branch": "master" }
  ]
}
```

### 7.1 目录骨架（`/hk-init` 创建）

```
<workspace>/.harness/
├── kit.json              # 内容包选择、模型映射、git 远端、overlay 模式
├── deliverables/         # 活目录 + _archive/（增量 R<N> 段追加）
├── specs/                # 能力规格（模块化目录，低冲突设计）
├── memory/               # entries/ 按条目单文件 + index.md
├── tasks/board.md
├── agents/ flows/        # 可选：项目级覆写
└── templates/            # 可选：项目级覆写
```

### 7.2 git 绑定三种情形（`/hk-init` 旗标裁决，M1 已落地）

**默认布局：独立资产仓库**（裁决 4，2026-11-09）。多端源码场景下不存在天然的"宿主代码仓库"；资产是知识沉淀而非构建输入，mono 的原子性优势弱、体积/CI/权限劣势随规模放大。mono-repo 仅作为单代码仓库小项目的显式选项保留。

**挂载约定**：资产仓库的工作副本就是 `.harness/` 本身——`git clone <assets-url> .harness`，所有脚本的路径假设不变，git 操作收敛到一个目录；kit.json `assets` 段记录 mode/远端/分支。

M1 为旗标驱动的确定性实现（命令 handler 无法中途交互；交互式询问留待后续）：

1. **已有团队资产仓库**：`/hk-init --assets <url> [--branch b]` → `git clone` 为 `.harness/`（要求目录空/不存在，否则报错并给手工挂远端指引）；clone 完成后骨架补齐只补缺、远端已有文件（kit.json/memory/specs…）全部保留。
2. **没有仓库**：`/hk-init --assets init` → 骨架创建后 `git init` + 首次 commit，用户后续提供空远端后 `git remote add` + push。
3. **本地模式**：裸 `/hk-init` 或 `--assets local` → 不绑定 git（默认）。
4. **既有绑定探测**：`.harness/.git` 已存在时（含用户手工 `git init`/挂远端后重跑），自动读出 mode/remote/branch 回填 kit.json。

### 7.3 同步与冲突策略（`/hk-sync` / 归档后自动触发，可配置）

- **低冲突设计**（继承当前 harness 的既有思路）：
  - memory 条目一人一文件（`entries/<date>-<slug>.md`），index 只追加；
  - specs 按能力域分目录，merge 以 `## R<N>` 段**追加**而非改写；
  - deliverables 归档为增量追加 + `rounds.md` 摘要追加。
- 同步流程（M3 已定稿实现）：自动提交本地变更（`harness: sync <时间>`，资产仓库为 harness 专有）→ `git pull --rebase` → 冲突时仅对**纯追加白名单**（`memory/index.md`、`specs/_index.md`、`tasks/board.md`、`_archive/*/rounds.md`）做自动三路合并（ours=base+A ∧ theirs=base+B ⇒ base+A+B，非前缀追加形态视为人工冲突）→ `git push`。
- 非白名单冲突：**中止 rebase 回滚到同步前状态**（本地自动提交保留、远端零污染）并列出冲突文件转人工，不留半成品 rebase 现场。
- **归档后自动触发**：kit.json `assets.autoSync=true` 时 `/hk-archive` 成功后自动执行同一同步例程，结果并入归档汇报；默认关闭。
- **审批说明（修正原设想）**：插件 handler 直接 spawn git（不经 bash 工具审批链，approval=ask 不会弹窗）。`/hk-sync` 本身是显式用户命令即授权；autoSync 需显式配置开启；所有 git 操作与结果写入命令返回文本，保证可审计。

### 7.4 宿主指令文件适配（AGENTS.md 优先，兼容 CLAUDE.md）

**背景**：`/hk-init` 需要生成项目知识入口（子工程地图、构建命令、代码规范、红线）。各宿主约定不同：Claude Code 读 `CLAUDE.md`，Codex 等读 `AGENTS.md`；DSH 默认两者都读（`@deepseek-ai/dsh-agent-instructions`，候选 `AGENTS.md` / `CLAUDE.md`，项目根到 cwd）。

**本项目主要面向 DSH，规则简化为：**

1. 子工程已有 `AGENTS.md` 或 `CLAUDE.md` 任一 → **不生成缺少的那个**，不覆盖已有内容；
2. 两个都没有 → **只生成 `AGENTS.md`**，不生成 `CLAUDE.md`；
3. 两个都有 → 不自动合并；初始化报告标注“双源”，由人决定是否收敛；
4. 已有 `CLAUDE.md` 视为 legacy，DSH 仍可直接读取，不强制迁移。

**生成位置**：

```
仓库根：
├── AGENTS.md            ← 新项目默认入口（项目地图 + 构建命令 + 红线）
├── CLAUDE.md            ← 仅当项目已有；DSH 兼容读取（不自动生成）
├── services/<端>/AGENTS.md  ← 新生成入口；已有 CLAUDE.md 则跳过
└── .harness/codebase-guide/ ← 按需加载层，承担省 context 的主要职责
```

**关键设计原则**：

1. **不制造双源**：新项目只生成 AGENTS.md；已有 CLAUDE.md 不改写，避免两份正文漂移。
2. **DSH 原生读取**：DSH 默认同时读取 AGENTS.md/CLAUDE.md；子工程文件从项目根到会话 cwd 生效，进入子目录后由文件操作触发补载。
3. **不赌指针**：`See @AGENTS.md` 不是 DSH 的加载机制；DSH 读 AGENTS 本身，因此新项目不需要 CLAUDE 指针。
4. **不赌宿主惰性加载**：正确性由 codebase-guide 的“索引常驻 + 详情按需”保证，子目录入口只是附加红利。
5. **运行时纪律不进指令文件**：由内核 preset/命令/护栏承接。
6. **init 幂等**：只创建缺失项；已有任一入口就跳过，不覆盖、不自动迁移。
7. **存量迁移由人决定**：需要统一时，人工把 CLAUDE.md 内容移入 AGENTS.md 并删除旧正文；插件不自动改写。

---

## 8. 默认内容包：ai-coding（从当前工程抽取）

| 当前资产 | 抽取目标 | 改造点 |
|---|---|---|
| `.claude/agents/*.md`（7 角色） | 内容包 `agents/*.md` | 加 frontmatter（role/model/write_scopes），去除 Claude Code 专有引用 |
| `.harness/workflow/*.md|json` | 内容包 `flows/*.yml` + `_router.yml` | 四种 Profile → 4 个 flow + 路由表；transitions.json 并入 flow 定义 |
| `.claude/skills/*.md`（4 个） | 内容包 `skills/` | 补标准 frontmatter |
| `.claude/commands/*.md`（6 个） | 内核命令实现（TS） | 命令逻辑进内核，MD 中的流程说明进 Lead 编排提示词 |
| `.claude/hooks/*.py` | 内核护栏（JS） | 见 §4.3 |
| `.claude/rules/*.md`、CLAUDE.md | 内核 Lead 提示词段落 + 内容包 `rules/` | 领域无关部分（审批纪律、澄清义务）进内核；项目知识部分进 AGENTS.md 规范源（§7.4）；存量 CLAUDE.md 保留为 legacy，不自动迁移；需要统一时由人移到 AGENTS.md |
| `.harness/codebase-guide/` | 内核按需加载机制（§7.4）+ init 生成逻辑 | 从"项目资产"升格为内核机制；DSH 宿主上模块文档另注册为 skill |
| `.harness/scripts/*.py` | 内核脚本目录（随包分发）+ MCP tools | 路径参数化（不再硬编码 `.harness/` 相对假设之外的逻辑） |
| `.harness/templates/`（dotnet/java/js） | 内容包 `templates/` | 原样 |
| `.harness/specs|memory|deliverables|tasks` | **不抽取**，留在项目 | 它们就是项目资产层的实例 |
| `services/` submodule 约定 + `.gitmodules` | 内容包 ai-coding 的 setup 钩子 + kit.json `sources:` 段 | 默认改为普通 clone；submodule 作为 setup 可选项 |

---

## 9. 插件包结构（DSH bundle）

```
harness-kit/
├── package.json               # dsh.bundle.patch 声明
├── cordis.patch.yml           # Host 插件行 + preset 覆写行
├── index.js                   # Host 入口：注册命令/护栏/工具/角色注册器
├── client.js                  # （里程碑 M3）任务板 UI 面板
├── kernel/
│   ├── role-registry.js       # 角色扫描 → preset 注册
│   ├── flow-engine.js         # 流程 YAML → 编排提示词编译
│   ├── guards.js              # ToolGuard 集
│   ├── sync.js                # git 同步（/hk-sync + 归档后 autoSync；脚手架在 commands.js）
│   ├── models.js              # 逻辑模型解析 + 派发说明生成（校验由 Lead 派发时执行）
│   └── commands.js            # /hk-* 注册
├── scripts/                   # Python 脚本集（从现工程抽取参数化）
├── packs/
│   └── ai-coding/             # 默认内容包（§8）
│       ├── agents/ flows/ skills/ templates/ rules/
├── mcp/
│   └── server.js              # MCP 宿主入口（§5）
├── locale/{en,zh}.json
└── icon.svg
```

## 10. 安全与沙箱

- 插件代码只在 `install_bundle` 时经审批进入 profile；运行时文件操作限于 workspace-write 沙箱。
- 面板 HTTP 路由全部是 owner-private（工作区路径、命令执行、文件浏览、git 操作）：每个 handler 前调用 `ctx.connection.requestRejection(req)`，命中即返回 401/403；`connection` 不可用时路由不挂载（fail closed），不允许裸 `webServer.register`。
- 脚本子进程继承 bash 工具的审批策略；git push 等写远端操作每次弹确认（可在 profile 中配置白名单）。
- 内容包来自插件市场/第三方时，角色提示词属于"不可信指令源"：内核在激活第三方内容包时向用户明示其包含的角色与流程清单。

## 11. 实施路线图

| 里程碑 | 范围 | 验收 |
|---|---|---|
| **M1 内核骨架 + ai-coding 直通** | bundle 骨架、`/hk-setup`（代码仓库收集+普通 clone+清单登记）、`/hk-init`（骨架 + 资产仓库绑定三情形 + 脚本/模板资产物化 + init 流程编排：子工程探测→计划确认→CLAUDE.md/build.json/CODE_STANDARDS/模块文档生成→CodeGraph 索引→校验诊断）、`/hk-fix` 端到端、角色注册器（工作区覆写）、脚本子进程调用、写禁区护栏 | 在本仓库用插件跑通一个真实 fix 任务；空目录从 setup 到 init 全通 |
| **M2 完整流程 + 模型路由** ✅（2026-11-10 实现完成） | 四 Profile flows、`/hk-new|propose|apply|archive`、审批点 ask_user_question 化、逻辑模型映射与派发 | 跑通一个 standard 全流程任务；SA 与 TE 使用不同模型 |

> **M2 实施记录**（回归套件 54/54 绿）：
> - **flows**：`standard/quick/bugfix/refactor` 四 Profile + `_router.yml` 路由表 + `new.yml`（Bootstrap 编排：解读→起草→Profile 判定→⛔模糊点反问→⛔定稿）；全流程阶段按 `phase: propose|apply` 打标，`compileFlowPrompt` 按 phase 过滤只渲染当前阶段。
> - **命令**：`/hk-new`（proposal 脚手架 + `--file` 需求文件拷入 + 看板 PENDING 登记 + Bootstrap steer）；`/hk-propose`（状态须 approved → 按 proposal `**profile**` 行取 profile，模板枚举行自动排除 → 只渲染 propose 阶段）；`/hk-apply`（审批 1 记录 + 就绪预检：standard/refactor 查 readiness-report、quick 查 design 就绪自评、bugfix 查结论，最后结论非 PASS 拒绝 → 只渲染 apply 阶段，支持反馈续接）；`/hk-archive`（fix：缺裁决 FAIL、`--full` 一致性校验 code-review+test-report；全流程：缺「审批 1：通过」FAIL、test-report 结论须 PASS，归档后 steer Spec/Memory Merge 收尾剧本）。
> - **状态机**：`state.js` 双规划文档规则——`proposal.md` 存在 → 审批 1 marker（`审批\s*1…通过|PASS`）解锁；否则 `bugfix.md` 质量门裁决解锁（兼容 fix 直通与全流程 bugfix 两种 bugfix.md）。
> - **模型路由**：`kernel/models.js`——角色 frontmatter/阶段 `model:` 为逻辑名，`kit.json models` 映射 `{provider, model, reasoning_effort?}`；派发说明随剧本注入（含 `list_subagent_models` 预校验、不可用降级会话默认并告知）；`resolveModel/describeModel/dispatchSection` 三个纯函数。默认 `models: {}` 全部走会话默认，映射由用户按工作区配置。
> - **hk-doctor** 增列：八个流程定义状态 + 模型映射表。
> - **脚手架补齐**（真机验收反馈）：`/hk-init` 幂等物化 `codebase-guide/overview.md` 与 `specs/_index.md` 预置骨架——对应旧框架「模板预置 + 人/AI 逐步补全」约定（`codebase_guide_init.py` 明确不生成二者），消除存量工程首批任务时 BA/SA/RR 输入引用悬空。
> - **格式契约补齐**（2026-11-11 真机归档反馈）：移植旧框架 spec/memory 格式契约——新增内容包模板 `spec-template.md`（frontmatter：domain/prefix/id_max_r/id_max_s/retired…）与 `memory-entry.md`（frontmatter id/date/scope/tags + 症状/根因/修复/流程优化排除/防复发/复发检测，文件名 `YYYY-MM-DD_<scope>_<slug>.md`），`/hk-init` 物化为 `.harness/specs/spec-template.md` 与 `.harness/memory/templates/entry.md`；`memory/index.md` 骨架扩为含命名约定/何时写不写/流程优先决策门，`specs/_index.md` 骨架补跨域流程节；`/hk-archive` 收尾提示词锚定两个模板。此前演示任务由 PM 自由发挥的轻量格式（无 frontmatter/日期前缀）属契约缺失所致。
> - **流程资产缺口补齐**（2026-11-11，演示任务 shared 条目上报的「流程优先」修复落地）：内容包新增 `verify.py` 硬门禁脚本（阶段1/2 按存在性自适应：无 `sync.py`/`.gitmodules` 即跳过，非子模块布局可用；阶段3 CLAUDE.md 行数、3.5 裸 NUL 字节、4 构建不变）与 `code-standards.md` 跨端编码底线（注入防护/资源释放/异常/日志/并发/缓存一致性），`/hk-init` 物化到 `.harness/scripts/` 与 `.harness/rules/`（create-only）；CR/Dev/TE 契约引用的两条路径自此不再悬空。演示机真机验证：verify.py 全绿（exit 0）。
> - **看板格式契约对齐**（2026-11-11）：`board.md` 骨架与内核 `updateBoard` 切到旧契约 7 列（`任务名|状态|Profile|Apply进度|分支|上次活动|续接提示` + 状态机/续接提示规范头部）——脚本层 `lib.py _board_rows` 硬编码该列序（[1]状态 [2]Profile [4]分支），此前 4 列简表会使 `get_board_branch` 落空、archive 合并静默误判「未参与本轮」。内核只机械更新状态/上次活动两列并保留其余列（Profile/分支/续接提示由 PM 按剧本维护）。
> - **剩余目录核对与悬空引用清理**（2026-11-11，全目录格式审计收尾）：① **spec_lint.py 移植**——旧工程 `spec-lint.py`（Spec 编号门禁：前缀/id_max/退役码/重号/残留原始块/SHALL/TBD）入包为 `spec_lint.py`，`discover_specs` 由旧目录布局 `**/spec.md` 适配为 `**/*.md` 排除 `_` 前缀/README/spec-template（兼容扁平 `specs/<domain>.md` 与目录两种布局），归档 PM 提示的门禁引用自此有实体；② **PM 契约悬空修复**——`project-manager.md` 前置检查原硬依赖未随包的 `check_harness.py --preflight`（783 行，深耦合 `.claude/` 布局，不移植），改为「CodeGraph 索引（`check_codegraph.py --sync --all`）+ 结构完整（/hk-init create-only）」，check_harness.py 存在时（旧工程/挂载）降级可选；成功标准归档门禁改指 `spec_lint.py`；③ **harness.py shim 防崩**——SCRIPTS 表按脚本存在性运行时过滤，未物化命令（archive/spec-merge 等旧流程脚本）隐藏并给出明确提示；④ **codebase-guide/index.md 骨架**由一行占位升级为路由表（三层知识模型 + 按角色路由 + 文件清单，`.claude/rules` 引用适配为 `.harness/rules`）；⑤ 核对结论：deliverables 七类文档结构符合内容包契约（R<N> 轮次段/REQ 编号/CR 清单 A-C/就绪 A0-A4）、memory/specs/board 此前已对齐、kit.json（url/assets 键）与 .gitignore 无冲突，JMeter/e2e 系列脚本属未移植领域（M3c 前不核）。回归 80/80。
> - **hk-doctor 全量对账**（2026-11-11）：体检「初始化资产」从抽查 2 项扩为与 `/hk-init` 物化契约逐项对账（9 脚本 + rules/code-standards.md + spec/memory 模板 + templates 目录），缺件逐一点名并指引重跑 `/hk-init`；新增「看板契约」行——board.md 非 7 列表头时告警（防 4 列旧简表使 `lib.py` 分支列读取落空）。演示机 `/hk-doctor` 全绿。回归 84/84。
> - **已有资产接管空远端**（2026-11-11，演示机 `/hk-init --assets <url>` 被拒暴露的缺口）：`--assets <url>` 遇 `.harness/` 非空时不再一律拒绝——先 `git ls-remote` 探测：**远端为空仓库** → 自动接管（`git init` + 绑定 origin + 骨架/物化完成后整体首次提交 `harness: 初始资产导入` + `push -u`），已有资产原样保留；**远端非空**（同名文件需取舍）维持拒绝并指引人工合并；远端不可达单独报错。接管提交/推送失败降级为警告并指引 `/hk-sync` 重试，绑定关系仍落盘。回归 87/87。
> - **资产分层：scripts 退出资产仓库**（2026-11-11，裁定前提：不考虑 M3c，所有消费场景都跑 DSH 插件）：`.harness/` 内文件分两层——**pack 管理运行时**（`scripts/`：门禁/探测工具，勿手改）不入资产仓库，`.gitignore` 排除，`/hk-init` 每次**覆盖式刷新**（pack 升级即刻生效，根治 create-only 漂移）；**播种资产**（`templates/`、`rules/code-standards.md`、spec/memory 模板：团队可裁剪打磨）维持提交 + create-only。存量仓库自动迁移：重跑 init 时若 `scripts/` 已被追踪则 `git rm --cached` 摘除（本地文件保留，摘除随下次 `/hk-sync` 推送）。若未来重启 M3c（非插件消费者），需重新评估本层划分。回归 93/93。
> - **spec 门禁内核化 + 运行时漂移检测**（2026-11-11）：① `/hk-archive` 预检新增第 3 关——全流程任务且 specs 已有实质 spec 文件时，内核直接执行 `spec_lint.py`，FAIL 即拒绝归档（原仅 steer 提示，PM 可能漏跑）；首个任务 specs 为空时跳过（lint 的「无 spec 文件」退出码不算违规）。② `/hk-doctor` 新增「运行时脚本」行：逐文件比对 `.harness/scripts/` 与 pack 内容，漂移（手改/pack 升级未刷新）点名到文件并指引重跑 `/hk-init`。回归 97/97。
> - **M4 UI 增强（Client 面板）**（2026-11-11）：① **数据通道**——Host `webServer` 服务挂两个 exact 路由：GET `/harness-kit/state`（遍历 `workspaceRegistry.list()`，含 `.harness/` 的工作区输出看板 7 列 + 流程进度 + 会话存活态）与 POST `/harness-kit/command`（`{workspace, line}`，仅放行 `/hk-*`，经 `agents.get` 找活动会话后 `commands.execute` 转发）；弃用 host.call（Host 事件目录无 client-call 通道）。② **进度推导**（`kernel/panel.js`，纯函数可测）：worker 阶段以 do 行「产出 xxx.md」在活目录的存在性置 done；审批阶段以 proposal.md/bugfix.md 中「<阶段名>：通过」标记判定；无 Profile 列时按 bugfix.md 推断 fix 流；DONE 任务全程置 done（活目录已清空）；每任务下发 action kind（propose/apply/archive/reopen/wait）。③ **Client 面板**（`client.js`，React.createElement 无 JSX）：`sidebar.panellist` 图标 + `main` 面板，3s 轮询；任务板表格 + 阶段 chip（⛔ 标记审批点，done/current/pending 三态）+ 操作按钮（立项/体检/同步/继续推进/归档），等待审批时显示指引不发命令。④ **package.json** 增 `./client` 导出 + `dsh.client {platform:web, immediately:true}`。⑤ **热重载教训**：`webServer.register` 的 disposer 只经 `ctx.effect` 随 fiber 销毁执行（apply 返回值不被调用），首版未挂导致 toggle 后旧路由残留、重复注册报错——已加 duplicate 容忍 + ctx.effect 双保险；史前残留路由需重启 Host 才刷新（仅影响 DONE 任务 chip 显示，功能无碍）。回归 110/110；curl 验证：state 返回两工作区、command 白名单/未知工作区拦截、正向派发 `/hk-doctor` 返回 ok。
> - **M4b 面板 v2 落地**（2026-11-11）：按 §13 全量实现——① Host `kernel/panel.js` 重写（约 486 行）：新增 GET `/harness-kit/config`（读 kit.json + 同步健康）、POST 同径（`updateKit` 校验式部分更新：sources 分支/autoSync/models 映射，非法项逐条人话报错）、GET `/harness-kit/activity`（资产仓库 `git log -n 50` → 团队动态）、POST `/harness-kit/sync`（不占会话手动同步，409 表阻塞）；`syncHealth`/`teamActivity` 5 分钟缓存 + 后台计算，冷启动返回 checking；`claims.json` 追加式认领（`/hk-propose` 成功即自动认领，git user.name 兜底 os.userInfo）+ `laneOf`/`attentionItems` 纯函数（block=待审批+同步阻塞、warn=待归档+同步落后）。② `client.js` v2 全量重写（约 487 行）：顶栏（工作区切换/同步圆点/＋🕘⚙）→「需要你」注意力条（红 block/橙 warn，逐项处置按钮）→ 三泳道看板（规划/实施/待归档）→ 底部折叠历史板（DONE，可搜索/重开）；卡片=圆点进度（◆审批点+呼吸动效）+ 单主按钮 + ⋯ + 就地展开；立项居中模态；配置视图三层（只读/可编辑逐项保存/危险操作仅 CLI）；团队动态按天时间线；toast 反馈；全主题 token。③ 「转到会话」经 `uiWorkspace.openSession`（可选服务，undefined 守卫）。回归 **130/130**（+20 M4b 用例含自动认领断言）。
> - **热重载教训修正（第二版）**（2026-11-12，M4b 端点 404 真根因定论）：上一版归因为「Node ESM 模块缓存、必须重启 App」——**错误**。真根因是 `index.js` 的「双保险」误用 Cordis API：`ctx.effect(fn)` 的语义是**立即执行** `fn`（其返回值才是 disposer），并非「把 fn 挂到 fiber 销毁时执行」。于是每次 apply 完成后毫秒级内，5 条路由 disposer 被当场执行、路由即摘即挂——fiber 本身始终存活（命令/守卫一直可用），只是路由被自家人秒摘。佐证：给 disposer 打日志后看到 `mounted` 与 `DISPOSE` 同毫秒出现。**修复**：删除 `ctx.effect` 循环，仅保留 `return () => disposers.forEach(d => d())`（返回 cleanup 由运行时在 fiber 销毁时统一执行）；同时保留 webServer disposer 的 identity 守卫（其按 key `table.delete(path)`，旧 fiber 延迟 dispose 会误删新 fiber 注册）。**运维约定改写**：改 `kernel/` 后 disable→enable toggle **即可加载新代码**（已反复证实），无需重启 App；App 重启仅在路由被史前无守卫实例占用（duplicate 容忍路径）时需要。修复后真机验证（2026-11-12 08:53+08:00）：`/state` `/config` `/activity` 200、载荷正确（30 任务看板 + lanes/claims/syncHealth），40 秒稳定性复测通过，`/sync` 返回人话文案，`/command` 未知工作区 404 拦截，回归 130/130。
| **M3a git 同步** ✅（2026-11-11 验收完成） | `/hk-sync`（自动提交 → pull --rebase / 纯追加文件三路合并 / 冲突中止回滚转人工 → push）、归档后自动触发（kit.json `assets.autoSync`） | 2026-11-10：`kernel/sync.js` + 回归（含双客户端实 git 冲突场景）；2026-11-11 演示机验收通过：空仓库经 `/hk-init --assets` 自动接管推送 + `/hk-sync` 真机走通 |
| **M3b MCP 宿主（暂缓）** | MCP server、WorkBuddy/Claude Code 挂载验证 | 未开始（用户裁定 M3 先不做） |
| **M4 UI 增强** ✅（2026-11-11 端点验证通过，GUI 面板待人验） | Client 面板：任务板、流程进度、审批入口 | GUI 内可视化流程状态 |
| **M4b 面板 v2** ✅（2026-11-12 真机验收通过：五端点全 200 + 40s 稳定性复测，回归 130/130；UI 视觉待用户刷新页面确认） | 作战室重构：注意力条 + 泳道 + 配置/团队动态视图 + 认领/同步健康 | 产品决议 2026-11-11（§13）；Host `panel.js` 重写（state/config/activity/sync/command 五端点 + claims/syncHealth/teamActivity）+ `client.js` v2 全量重写 + `/hk-propose` 自动认领；404 根因修复（ctx.effect 误用）见上方教训第二版 |

## 12. 开放问题裁决记录（2026-11-09 已全部裁决）

| # | 问题 | 裁决 | 落地影响 |
|---|---|---|---|
| 1 | 内容包分发形态 | **M1 随内核 bundle，M3 起支持独立 bundle** | §9 包结构不变；M3 增加内容包独立打包/安装路径 |
| 2 | 流程引擎形态 | **先"YAML 编译为 Lead 编排提示词"** | workflowEngine 硬状态机无限期搁置，除非提示词编排在实践中失控 |
| 3 | Worker 是否需要 durable teammate 载体 | **当前不需要** | §4.2 维持：PM=Lead、Worker=subagent；异构模型派发无阻碍 |
| 4 | 资产仓库布局 | **默认独立资产仓库**（mono 保留为显式选项） | §7.2 已更新默认与挂载约定 |
| 5 | 命令前缀 | **`hk-`** | §4.1 命令表维持现状 |

---

## 13. 面板 v2 产品决议（M4b，2026-11-11 全部裁定）

**定位转变**：从「看板优先」转为「作战室优先」——历史任务看板低频，默认视图服务"开发中"状态；Routa 借鉴四点（Blocked 一等公民、泳道专家可视化、DoD 双层=开发完成 vs 交付完成、卡片→会话可追溯跳转），不借鉴拖拽全能看板/ACP/实时多 agent 画面（编排主权留在会话 PM，面板=状态投影+操作入口）。

**主视图 IA**（用户裁定逐项 ✅）：

| # | 决议 | 说明 |
|---|---|---|
| 1 | 「需要你」置顶 | 待审批/待裁决/待归档/**资产同步阻塞·落后**（红=阻塞、橙=警告），解决即消失 |
| 2 | 主区泳道三列 | 规划中 / 实施中 / 待归档，卡片随进度左→右流动；窄屏（<720px）纵向堆叠 |
| 3 | 历史任务板 | 主视图**底部折叠区**（非独立视图），只收 DONE/已归档，展开后表格+搜索 |
| 4 | 卡片详情 | **就地展开**（产物列表/分支/Apply 进度/续接提示），不做右侧抽屉 |
| 5 | 立项入口 | 顶栏「＋」→ **居中模态**（任务名/描述/需求文件路径） |
| 6 | 不做「标记通过」 | 审批标记维持人手写入，面板不提供代写按钮（防审批流于形式） |
| 7 | 「转到会话」值得投入 | 卡片 ⋯ 菜单跳该工作区活会话（Client layout/sessions 可行性待验证） |

**卡片视觉密度**：阶段进度用 8 圆点进度条（●绿完成 / ◐蓝呼吸当前 / ○灰未到 / ◆菱形审批点，hover tooltip 显示阶段名+产物），不用文字 chip；文字仅任务名（14 半粗）+ 流程徽标胶囊 + 当前状态行（角色·相对时间，12 灰）；每卡单一主按钮（蓝实心），次操作收 ⋯。色彩只取主题 token，红仅给阻塞项；动效仅圆点呼吸+按钮 loading；空状态做正式插画位+立项 CTA。操作反馈：toast 成功 3s 自消、失败红色滞留。

**配置视图**（顶栏 ⚙，独立视图+返回）：三层——① 只读信息（资产仓库 url/branch/mode、同步健康、上次同步、pack 版本+漂移摘要）；② 可配项（各端基线分支 `sources[].branch`、`assets.autoSync`、Worker 模型映射），分组卡片独立保存；③ 危险操作（资产换绑/解绑、增删 source）维持命令行，面板只显示不提供表单。

**团队协作三件套**（用户裁定 ✅）：

1. **同步健康进「需要你」**：git 检查有网络成本——缓存 + 低频后台检查（≈5 分钟）+ 顶栏「立即同步」按钮（走 Host 端点，不占会话）；同步失败原因翻译成人话并给处置入口。
2. **任务认领**：`.harness/tasks/claims.json` **追加式**（不动 board 7 列契约，纳入纯追加白名单自动合并），`/hk-propose` 时 PM 自动认领无需用户操作；面板显示认领人，防止两人同做一任务。
3. **团队动态**：顶栏 🕘 独立视图（时间线：git author 首字母圆点 + 谁·归档了 X/新增 memory Y·时间，按天分组），数据来自资产仓库 git log。

---

## 14. 看板列格式契约与防漂移（M4c，2026-11-12 全部裁定并落地）

**事故**：iot-harness 看板自由手写漂移——`kafka-forward-sasl` 行 15 列/11.3 万字符、`order_opcua` 行 16 列/4.4 万字符、状态列夹带整段括注、表头/分隔线被空格撑到 3.8 万字符；面板 state 端点整板内嵌导致载荷膨胀。

**根因**：内核 `updateBoard` 只机械写「状态/上次活动」两列，其余四列由 PM/Worker 凭模板 blockquote 建议自由手写——无 schema、无校验、无消毒；`split('|')` 朴素解析遇自由文本含 `|` 即破列错位。

**裁定（方案 A：单一写入入口 + 写时校验）**：

1. **`update_board.py` 为看板唯一写入门禁**：PM/Worker 禁止直接编辑 board.md，一律 `python3 .harness/scripts/update_board.py <任务> [--status/--profile/--apply/--branch/--hint]`；脚本随 pack 分发、入 doctor 资产清单，`--check` 供 doctor 体检，`--repair [--write]` 规范化存量。
2. **列格式收紧（用户逐项裁定 ✅）**：① Apply进度 固定语法 `—｜已归档｜R<n>：阶段链`（阶段词表 propose/审批1/Dev/CR/TE/审批2/验证 + 后缀 ✅/…/⛔/—）；② 任务依赖写续接提示前缀 `[等 任务名]`，不加新列；③ 上次活动精度提升到分钟（`YYYY-MM-DD HH:mm`，写入方自动打）；④ 不加优先级列（追加顺序即优先级）。
3. **读侧防御**：`parseBoard`（panel.js）、`parseBoardRow`（commands.js）、`_board_rows`（lib.py）、`update_board.py parse_row` **四方同源容错**——超列溢出并入「续接提示」，不足 7 格补 `—`，[1]状态 [2]Profile [4]分支 下标永不因坏行错位。
4. **存量修复**：一次性 `--repair`（破列合并、状态提纯、Profile 归一 bugfix→fix、消毒去 `|`/`**`/换行、提示截断 ≤80、DONE→已归档）+ 10 个在途任务按实际进度手工改写 Apply进度。修复后 iot-harness 看板 245KB → 9.7KB，37 行全合规。
5. **哲学**：看板是索引层不是档案层——只回答「有哪些任务、卡在哪、谁在做」，详情属于 deliverables/memory/specs。字段若继续膨胀，演化方向是 JSONL 结构化存储（方案 B，本次未取）。

**2026-11-12 下午补**：

- **一任务一行**：发现 `kafka-cert-materialize` 重复行（9 月 DONE 归档行 + 延期 PENDING 行并存）。`--check` 检出重复任务名、`--repair` 自动合并（DONE 是终态快照，保留最后一个非 DONE 行）、写入时遇重复拒绝并提示先 repair。iot-harness 看板 37 → 36 行。
- **机械截断的善后**：`--repair` 对超长提示是硬截断（80 字符断句）。18 条受影响提示已按原文（备份）手工改写为 ≤80 字完整句，全部经写入门禁落盘。
- **iot-harness 本地 PM 覆盖**（`.harness/agents/project-manager.md`，系 `.claude/agents/` 的符号链接）已同步看板写入纪律与 `update_board.py` 用法。
- **Profile 枚举更正**：`update_board.py` 初版误写 `full|standard|quick|fix`——`full` 其实是 fix 直通的质量门裁决词（`--full`）而非 profile；真正的内核四档是 **standard / quick / bugfix / refactor**（router/readProfile/refactor.yml 本就支持 refactor，看板列用短名 fix 对应 proposal 的 bugfix，lib.py 认 fix）。已更正为 `standard|quick|fix|refactor|待裁决…|—`，iot-harness 三行历史 `refactor`（kafka-forward-sasl、fix_dataservice_threads、create-data-optimize）经门禁恢复。
- **冷启动 404（已修）**：`registerPanelApi` 依赖的 `webServer`/`workspaceRegistry` 是异步启动的 cordis 服务。插件若随会话**中途启用**（服务已就绪）一切正常；但**冷启动**时 `apply` 先于服务就绪，`ctx.get` 返回 undefined，路由静默不挂载 → 面板「一直加载中」、端点 404。修复：`index.js` 改用 `ctx.inject(['webServer','workspaceRegistry','connection'], cb)` 依赖注入回调挂载路由（cordis 源码确认：依赖就绪后才执行回调，回调返回值作为该 fiber 的 disposer）。
- **`--at` 回填**：`update_board.py` 新增 `--at YYYY-MM-DD[ HH:mm]`（仅日期补 `00:00`）覆盖活动时间戳——用于一次性回填被误刷的「上次活动」，iot-harness 36 行历史日期已按备份恢复。
- **已知限制**：DSH 宿主进程对插件模块有 ESM 缓存，`set_plugin` 开关不会重新 import——kernel 代码改动需**重启 App** 生效（搬仓后出现过 PACK_ROOT 悬空导致 loadFlow 恒 null、面板进度点全空，重启即恢复）。

**2026-11-12 下午第二批（面板 UX 四问题，全部落地）**：

1. **Toast 不消失**：client.js 原来只有成功 toast 自动消失（3s），错误 toast 只能点击关闭 → 「当前工作区没有会话」常驻。修复：错误 toast 6s 自动消失，点击仍可立即关。
2. **无活动会话 409**：`/harness-kit/command` 要求活会话（命令注入 steer 需要 agent）。修复（客户端兜底）：run() 收到「没有活动会话」409 → 自动 `uiWorkspace.openSession(最近会话)`（无会话则 `openWorkspace(ws.id)` 开空白会话）→ 2.5s 后自动重试一次，仍失败则提示用户手动开会话。「跳转会话」同样兜底：无 live 会话时打开最近会话/新建会话而非仅报错。
3. **任务名强制英文必填**：① 命名规则放宽为中英文/数字/`-_`（`TASK_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u`，内核 + 面板同源）；② 任务名改**可选**，留空（或 `--auto`）由内核按描述确定性派生 slug——英文词取前 4 个 kebab、纯中文回退 `auto-YYYYMMDD-HHmm`、撞目录自动加 `-2/-3`。注意 `parseArgs` 会把 `--auto` 后首个词吞作旗标值，hk-new/hk-fix 须还原完整词序再解构，且 --auto 时全部词都是描述（不能先切首个当任务名）。
4. **Apply进度 v3：按 profile 表达真实流程**：原语法是固定 7 阶段一条链，fix 直通（从质量门起步、无审批）与 refactor（前置影响面）都表达不了，且与面板进度点（按 flow yml 派生）对不上。修订：`update_board.py` 增加 `PROFILE_STAGES` 词表（standard/quick 七阶段、refactor 前置影响面、fix 覆盖 bugfix 全流程与直通两种起点）+ `▶` 当前标记（至多一个、与 ⛔ 互斥、✅ 须连续在链首），写入时按行 Profile 校验链语义，`--repair` 自动给在途任务的首个 `…` 推导 `▶`。panel.js `taskProgress` 同步修 fix 短名二义：活目录有 proposal.md → bugfix 全流程（含审批菱形点），仅 bugfix.md → fix 直通。iot-harness 36 行存量经 `--repair --write` 迁移 + 体检 PASS。
5. **新建任务弹窗改版**：模式切换按钮「需求 / fix 直通」（fix 隐藏需求文件字段、附流程差异说明），任务名占位提示「留空自动起名」，描述必填。
6. **hk-fix 补看板登记**：原来只 hk-new 写 PENDING 行，hk-fix 不上板；现已对齐（面板 fix 按钮依赖此行为）。

**2026-11-12 下午第三批（面板 UX 复审，全部落地）**：

1. **任务名收回中文支持**（用户裁决）：`TASK_NAME_RE` 回到 `/^[A-Za-z0-9][A-Za-z0-9_-]*$/`；中文描述请留空走 `--auto` 派生英文 slug。内核与面板校验同源，sim 改测中文名拒绝。
2. **进度圆点改由看板 Apply 链驱动**：v2 圆点从 flow yml 证据文件推导——多轮任务旧证据残留导致「4 绿 1 闪 3 灰」与看板「R10：Dev✅ 验证✅」矛盾。修复：`taskProgress` 优先解析 Apply 链（`parseApplyChain`，与 update_board.py v3 语法同源），链即圆点（✅绿 ▶蓝当前 …灰 ⛔红 —空心跳过，菱形=审批点，悬停 tooltip 带状态文字）；不合规链/`—` 回退证据推导（老数据兜底）。卡片圆点下方贴出链原文便于对照。`pendingApproval` 也从链推导（审批名阶段 ▶/… 且前序全 ✅）。iot-harness 36 行真实看板验证：`AWAITING_ARCHIVE` 任务圆点全绿、`审批2▶` 正确入「需要你」。
3. **命令执行现场可见**：`/harness-kit/command` 响应新增 `sessionId`（实际执行注入的会话）；客户端成功后 `uiWorkspace.openSession(sessionId)` 直接切过去——重开/继续实施/归档点了就能看到会话在跑，toast 改为「已发送到会话执行：…」。

**2026-11-12 傍晚第四批（链完整化 + 重开语义）**：

1. **Apply 链 v4：必须完整等于 profile 固定流程**（用户裁决：「不同 profile 的流程应该是固定的，除 fix 区分轻量/full」）。v3 允许省略阶段，导致 PM 手写「R4：Dev✅ CR— TE—」这类残缺链，面板与图二流程对不上。v4 规则：standard/quick=`propose 审批1 Dev CR TE 审批2 验证`，refactor 前置`影响面`，fix 短名按 `deliverables/<任务>/proposal.md` 消解（有→同 standard 模板；无→直通模板 `质量门 Dev CR TE 验证`）；**不许省略阶段**，跳过用 `—` 且仅 fix 直通轻量裁决的 CR/TE 允许。`update_board.py` 写入即拒残缺/非法链（新旧行都校验，错误信息带完整模板）；`--repair` 规范化存量：缺省阶段按位置补齐（最早进展前→✅、后→…；AWAITING_ARCHIVE 全✅）、非法 `—` 重推导；PENDING 已定档行补全 `…` 链。iot-harness 36 行迁移后全合规。
2. **重开按钮不再执行命令**（用户裁决）：DONE 任务「重开任务」= 只打开会话窗口（有历史会话则 openSession 带上下文恢复，没有则 openWorkspace 开新会话），用户进会话后自行发起重开。
3. 面板阶段名中文显示映射（propose→需求方案、Dev→开发、CR→代码审查、TE→测试、质量门/影响面…），圆点 tooltip 与卡片状态行统一。

**2026-11-12 深夜第五批（profile 三态消解 + 任务↔会话绑定）**：

1. **看板 profile 区分 bugfix / fix-full / fix-light 三态**（用户裁决）：v4 的 fix 短名二义（靠 proposal.md 反查模板）被显式枚举取代——`bugfix`=全流程；`fix-full`=直通走 CR→TE；`fix-light`=直通跳过 CR/TE（链上标 `—`）；裸 `fix` 降级为「裁决未定」过渡态，质量门裁决后 PM 必须立即 `update_board.py --profile fix-full|fix-light` 改写。`profile_template()` 改为自描述（profile 值即流程，不再读文件），三态消解逻辑集中在 `--repair`：proposal.md（活目录或 `_archive`）→ bugfix；bugfix.md 裁决行 `--full` → fix-full、`轻量` → fix-light；均无 → 保留 fix。`/hk-fix` 注册时按预声明直接定档（`--full`→fix-full、`--light`→fix-light 且 CR/TE 直接标 `—`、未声明→fix）。iot-harness 36 行再迁移：17 行消解为 bugfix/fix-full/fix-light，2 行确无裁决记录保留 fix 过渡态，`--check` 全合规。
2. **任务↔会话绑定**（用户裁决：「之后通过 DSH 开启的新任务都要记录对应对话窗的 session」）：`.harness/tasks/sessions.json`（`{tasks:{<任务>:{sessionId,at}}}`）。登记点：① `/harness-kit/command` 成功执行 hk-* 后按命令行 ASCII 任务名自动登记；② 客户端为无绑定任务新开会话后 `POST /harness-kit/bind-session` 回调。`workspaceState` 每行透出 `sessionId`。**「重开任务」「继续实施」「转到会话」统一为纯跳转**：绑定会话仍在工作区 → `openSession` 带上下文恢复；无绑定/会话不在列表 → `openWorkspace` 新开会话并绑定；绝不自动执行命令。已知边界：`--auto` 自动命名场景命令行解析不出任务名，待后续 hk-propose/apply 补绑。

**2026-11-12 深夜第六批（跳转收敛为「继续会话」单入口）**（用户裁决）：放弃「无会话则新开会话并绑定」路线（`openWorkspace` 新开窗口在本机反复验证不可靠，三轮修复未果）。新规则：**仅当任务有 session 绑定记录、且该会话仍在本机工作区会话列表中，任务卡主按钮/⋯菜单/注意力条才出现「继续会话」按钮**（`hasLiveSession(t)` 判定）；点击仅 `openSession(sessionId)` 直达对应会话窗口，失败 toast 报真实原因。无记录/会话不在本机 → 一律不显示跳转按钮（不支持接管他人任务）；「归档」「继续推进」等命令按钮不受影响。客户端不再调用 `openWorkspace`+`bind-session` 的新开会话路线（内核端点保留，供未来 hk-propose/apply 补绑使用）。工作区级 `jump()` 死代码移除。

**2026-11-12 深夜第六批补充**（用户裁决）：① 任务卡「⋯」菜单整体移除（含菜单内「继续会话」「运行体检」入口，menu/menuItem 样式与 menuTask 状态一并清理）；② 历史（DONE）任务一律不显示「重开」按钮——`primaryOf` 对 `reopen` 恒返回 null，且历史任务板表格「操作」列整列移除（原为 `run('/hk-apply <任务>')` 的「重开」按钮），历史表只保留 任务/Profile/完成时间 三列；「继续会话」只保留在进行中任务的 wait/apply 主按钮与本机有会话时的注意力条。

**2026-11-13 立项专属会话（修复「立项后看不到执行」）**：此前立项走通用 `run()`——`/harness-kit/command` 把命令注入「最近注册的任意活动会话」（实测劫持了无关的 68 轮旧会话），无活动会话时走 `openFallbackSession` 程序化开窗（第六批已判定不可靠的路径再次复现：新窗口停主页、侧栏无记录）。新流程 `runFresh()`（仅立项/hk-fix 模态使用）：① `uiWorkspace.openWorkspace(wsId, beforeOpen)` 在当前窗口创建/复用空白会话并直达，`beforeOpen` 同步捕获 sessionId；② `POST /harness-kit/command` 携带 `sessionId` **定向注入**——host 端轮询等该会话 agent 注册就绪（300ms×≤15s），替代旧的盲等 2.5s + 任意会话注入；③ 打开失败/导航被取代/`uiWorkspace` 不可用则自动回落旧路径。与第六批裁决的关系：放弃的是「无绑定任务按钮自动开窗执行」，本次恢复的是**立项动作本身的专属会话创建**（用户主动发起、且补齐了就绪等待与定向注入两块短板）；「继续会话」单入口规则不变。

**2026-11-13 补充（命令结果透传 + 空目录幂等）**：定向注入上线后首测暴露第二个静默失败点——用户清理残留后重试同名立项，hk-new 因空活目录撞名返回 err，但路由忽略 `commands.execute` 返回值（`CommandExecution|undefined`，command/run・done 仅 log-only 落盘、会话 UI 不可见），照旧报「已发送」并错误登记绑定，用户在新会话里依然什么都看不到。修复：① 路由检查返回值——`undefined` → 400「命令未注册或无法解析」；`result.kind==='error'` → 200 + `ok:false` + 真实错误文本（toast 可见）；**仅成功才登记任务↔会话绑定**；② hk-new/hk-fix 撞名守卫放宽：活目录存在但为空（中断/清理残留）→ 直接复用重建，有内容才报错。至此立项链路每个失败点都有用户可见的报错。同日增补：③ **立项会话命名**——hk-new/hk-fix 成功后调用 `ctx.sessionTitle.rename(agent.session, 任务名)` 把会话标题固定为任务名（user 源会 pin 标题、后续自动标题不再覆盖）；`--auto` 场景从成功文本的 `**task**` 提取任务名；命名失败静默不阻断。此前会话标题取自 steer 剧本首行（「# Harness Kit 任务调度指令…」），无法辨识。

**2026-11-13 自动续接引擎（修复「裁决完还要手动敲下一条命令」）**：此前流程在两个人工闸门之后断链——PM 无法执行斜杠命令，只能「提示人运行 /hk-propose」「之后运行 /hk-apply」。新引擎（host 侧 7s 轮询，挂在 panel fiber 上随重载生灭）接力两条边：**定稿（proposal.md 状态行 `approved`）+ 看板 PENDING → `/hk-propose <任务>`；审批 1 写入 + 看板 IN_PROGRESS → `/hk-apply <任务>`**。裁决本身仍是人做的（ask_user_question / 人审批），引擎只接力确定性闸门，与「审批/归档必须人证」的裁决不冲突。三重幂等守卫：① 看板状态是天然闸（hk-propose 成功即置 IN_PROGRESS）；② 一次性标记落盘 `.harness/tasks/auto-advance.json`（`task:hop → ISO`，host 重载后仍幂等；hk-new/hk-fix/hk-archive 清理对应任务标记，重建/归档后可重新接力）；③ 命令失败 5 分钟退避不刷屏。触发条件还要求任务有会话绑定且该 agent 在线，否则静默跳过（保留手动路径）。配套下沉：`kernel/bindings.js`（任务↔会话绑定表从 panel.js 抽出共用）、`kernel/advance.js`（扫描/标记纯函数）；**hk-new/hk-fix/hk-propose/hk-apply/hk-archive handler 内直接登记绑定**（`agent.session.id ?? agent.id`），覆盖「在会话里手敲命令」面板路由不在场的入口、并防止面板 legacy run() 劫持旧会话后绑定漂移（命令在哪个会话成功执行就绑定哪个会话）；`kit.json autoAdvance=false` 可整区关闭；new.yml 交接阶段改为告知「将自动进入 propose 阶段」。

**2026-11-13 继续推进定向化（修复「点继续推进打开无工作区窗口」）**：「继续推进」「归档」按钮此前走 legacy `run()`——不带 sessionId，host 路由用「最近注册的活动会话」启发式挑目标，sessions.json 里的任务绑定完全不参与；跳转发用 `uiWorkspace.openSession()` 只切当前窗口的选中会话、不切窗口的工作区上下文，面板窗口不在任务工作区时便呈现「没有工作区的窗口」。实测 iot-harness 工作区同时挂着 4 个活会话（含一个 14:37 被旧 openFallback/openWorkspace 路径造出的空会话），启发式随时可能挑错。修复：新增 `runTask(t)`——`hasLiveSession(t)` 为真时 `POST /harness-kit/command` 携带绑定 `sessionId` 定向注入（复用路由既有 300ms×≤15s 就绪轮询），成功后 `openSession(t.sessionId)` 直达绑定会话，**命令目标=跳转目标=绑定会话**；无存活绑定时回落 legacy `run()`（用户既有裁决保留）。绑定存在但 agent 不在线时 host 返回「目标会话尚未就绪」如实报错，不再悄悄劫持别的会话。纯 client.js 改动，Cmd+R 生效。

---

## 附录 A：可行性核验记录（2026-11-09，DSH 0.2.1-rc.5）

- `agentPresets.register(definition)` 公开服务方法，支持插件动态注册 preset；preset 声明行可被 bundle patch 覆写（`preset-<id>`）。
- `dsh-commands`：`ctx.commands.register()` 原生命令；plan-mode 为"命令驱动模型工作"的官方先例。
- `dsh-tools`：`ctx.tools.guard()` 同步护栏 + `tools/pre-execute` allow/deny/ask 事件链。
- `dsh-skill-filesystem`：扫描 `.dsh/skills`、`.agents/skills`、自定义目录，Chokidar watch 热加载；`bundledSkillDir` 支持包内默认 skills。
- `subagent` 工具支持 per-call `provider/model/reasoning_effort`；`workflow` phase 级模型覆盖；`list_subagent_models` 可校验。
- WorkBuddy 侧：官方支持 MCP 接入（workbuddy-mcp、CloudBase AI Toolkit 配置指南），MCP 宿主路线成立。
