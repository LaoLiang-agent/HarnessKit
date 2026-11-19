# 工程记忆规则

> `entries/` 是事实源；`index.md` 是 hot 路由表；`cold.md` 是 cold 路由表。
> 默认只读 `index.md`，cold 仅在 hot 无匹配时按需搜索。冷索引不删除条目。

## 命名

| 字段 | 格式 | 示例 | 约束 |
|---|---|---|---|
| 文件 | `YYYY-MM-DD_<scope>_<slug>.md` | `2026-04-22_shared_pm-heartbeat-drift.md` | 双下划线分隔；scope 小写；slug kebab-case、3-6 词 |
| id | `M-YYYYMMDD-<scope>-<slug>` | `M-20260422-shared-pm-heartbeat-drift` | frontmatter 稳定 id，不随文件名改 |
| scope | 六选一 | backend / frontend / mobile / tooling / infra / shared | 不许自造；跨多域优先 shared |
| tags | YAML 数组 | `[pagination, env, NaN]` | 3-5 个关键词 |
| areas | YAML 数组（可选） | `[phm/**, kafka-common/**]` | 模块/路径 glob，提升命中率 |
| symptoms | YAML 数组（可选） | `["Invalid keystore format", "getArgument"]` | 错误文本/方法名/配置键 |
| pinned | 布尔（可选） | `true` | 高风险条目，不自动降温 |

## 何时写 / 不写

| 写 | 不写 |
|---|---|
| CR REJECT / TE FAIL（实现层 bug） | 一次通过、0 REJECT/FAIL 的任务 |
| 开发中踩坑 ≥2 次尝试才解决 | 需求/方案本身错（应反馈到 proposal） |
| OS/依赖/配置类坑（有强复现性） | 同一任务内反复调试小细节（如 CSS 间距） |
| 编排层出现漂移（PM/Agent 契约不一致） | 没踩坑就没有经验要沉淀 |

## 流程优先

tooling / infra / shared 三类先问“能不能改流程（脚本·门禁·模板·命令·规则）”；能改流程就不写记忆，必须写时在条目里说明「流程优化排除」。

## 索引格式

条目一行，scope 放第一列：

```markdown
| scope | tags | 症状 / 触发 | entry |
```

匹配规则：`scope` 精确匹配，并且 `tags` / `areas` / `symptoms` 至少命中一项；不要 scope 对了就全部加载。单任务最多读 3 条。

## hot / cold

- `index.md`：hot，默认只读；每 scope 5–10 条，全局不超过 30 条。
- `cold.md`：cold，默认不读；仅 hot 无匹配时按 scope/tags/symptom 搜索。
- 自动降温：hot 条目超过 60 天未使用且未 `pinned` → 移入 cold。
- 冷条目再次使用后运行 `memory_index.py touch <id>` 提升回 hot。
- cold 不自动删除；只有人工确认退役/合并后才移出。

## 命令

```sh
python3 .harness/scripts/memory_index.py sync
python3 .harness/scripts/memory_index.py cool --days 60 --max-hot 30 --apply
python3 .harness/scripts/memory_index.py touch <id>
python3 .harness/scripts/memory_index.py check
```
