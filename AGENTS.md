# 项目指南（Harness Kit 生成）

本工作区由 Harness Kit 管理：多子工程协作、需求/设计/交付物与经验记忆全部沉淀在 `.harness/`。深入任何子工程前先查下表资源，不要凭猜测行动。

## 子工程地图

| 名称 | 路径 | 角色 | 分支 |
|---|---|---|---|
| （待 /hk-setup 登记） | | | |

## 工作区资源（.harness/）

| 资源 | 位置 | 说明 |
|---|---|---|
| 协作契约 | `.harness/kit.json` | pack、资产仓库绑定、子工程清单 |
| 系统能力索引 | `.harness/specs/_index.md` | 已有需求能力（Source of Truth） |
| 架构总览 | `.harness/codebase-guide/overview.md` | 技术栈、目录结构、子工程关系 |
| 知识路由 | `.harness/codebase-guide/index.md` | L1/L2/L3 三层知识模型与角色路由 |
| 任务看板 | `.harness/tasks/board.md` | 当前任务与质量门状态 |
| 经验记忆 | `.harness/memory/index.md` | 历史坑与流程优化条目 |
| 编码底线 | `.harness/rules/code-standards.md` | 跨端编码红线 |
| 交付物 | `.harness/deliverables/<任务>/` | 提案、需求、设计、测试报告 |

## 构建与运行

各子工程的编译/启动/测试命令以其自身 `services/<子工程>/.harness/build.json` 为唯一权威来源，本文件不重复登记。
统一执行入口（自动解析运行时环境）：`python3 .harness/scripts/harness.py run-field <子工程> compile|start|stop|test`。

## 红线

- 规划阶段（质量门未裁决）禁止修改 services/ 下子工程与 e2e/ 源码。
- 范围/口径/验收模糊时必须向人反问，禁止 AI 自行补全。

## 发布红线（每次会话必须遵守）

1. **版本号必须由人明确给出**：没有得到用户明确指定的版本号之前，禁止修改
   `package.json.version`、禁止 `npm version`、禁止打 `v*` tag。
2. **禁止本地 `npm publish` / `pnpm publish` / `yarn publish`**。本仓库的 npm
   发布只由 CI 完成：推送 `vX.Y.Z` tag 后自动触发。
3. 发版顺序固定为：
   - 用户明确版本号
   - 更新 `package.json` / `package-lock.json` / `CHANGELOG.md` / README 安装版本
   - `npm test` + `npm run pack:check`
   - 提交 `chore: release X.Y.Z`
   - 打 annotated tag `vX.Y.Z`
   - `git push origin main` 和 `git push origin vX.Y.Z`
   - 等 CI 发布，不要手动 publish
4. 用户只说“提交”“发版”但没给版本号时，先问版本号；不要自行推断。

