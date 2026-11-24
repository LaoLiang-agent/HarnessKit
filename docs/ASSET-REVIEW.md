# 资产审计：iot-harnessKit 的 specs 与 memory

> 审计日期：2026-11-20
> 审计对象：`/Users/leo/Server/sie/iot-harnessKit/.harness/{specs,memory}`（当前工作空间）
> 数据来源：工作区文件 + 本机 `~/.dsh/sessions` 中 iot-harnessKit 的 8 个会话日志
> 性质：只读审计 + 已执行的 hot/cold 试点；不改 Requirement 内容

## 1. 结论

- **memory 的设计方向合理，但使用很弱**：66 条 entry 中，当前工作空间日志里只发现 3 次 entry 读取，集中在 `phm-phm-iot`；memory index 也只有 5 次引用。
- **specs 确实在用，但加载粒度过粗**：`phm/spec.md` 75K 字符、65 个 Requirement、250 个 Scenario，日志中出现 43 次引用；主要是整文件/大段读取。
- 当前最大的风险不是“低价值 memory 被频繁加载”，而是 **memory 写得很多、读得很少**；一旦按 `scope=backend` 粗匹配，37 条 backend 条目又可能一次性进入上下文。
- 已做 hot/cold 试点：66 条 → hot 30 / cold 36；cold 默认不读、不删除。

## 2. 资产盘点

### memory

| 指标 | 数值 |
|---|---:|
| 条目数 | 66 |
| 条目总字符 | 157,873 |
| 平均每条约 | 2,392 字符 |
| 迁移前 `index.md` | 21,132 字符 |
| scope 分布 | backend 37、shared 9、tooling 7、infra 7、frontend 6 |
| 时间分布 | 2026-09 33、2026-11 16、2026-10 12、2026-08 5 |

### specs

| 指标 | 数值 |
|---|---:|
| spec 文件数 | 14 |
| 总字符 | 185,685 |
| Requirement | 205 |
| Scenario | 615 |
| `phm/spec.md` | 75,050 字符 / 65 R / 250 S / 1,787 行 |

最大的文件：

| 文件 | 字符 |
|---|---:|
| `phm/spec.md` | 75,050 |
| `message-trace/spec.md` | 27,369 |
| `data-forwarding/spec.md` | 26,188 |
| `thing/spec.md` | 17,031 |
| `rule-engine/spec.md` | 10,350 |

## 3. 实际使用证据

当前工作空间 8 个会话中：

- `memory/index.md` 被引用 5 次；
- `memory/entries/*.md` 只发现 3 次引用，集中在 `phm-phm-iot`：
  - `2026-11-13_backend_customquery-readside-no-parameterization.md`
  - `2026-11-17_frontend_vue2-newkey-not-reactive.md`
  - 一次 glob 引用（不是精确命中）
- 其余 60+ 条在现有日志中没有发现读取引用。

specs：

- `phm/spec.md` 43 次引用；
- `specs/_index.md` 11 次；
- 其他 spec 文件进入很少。

结论：**memory 写得多、检索少；specs 是主要上下文来源，但加载太粗。**

## 4. 发现的问题

### P0：memory 索引不是路由表

- 迁移前 `index.md` 21K 字符，条目行包含大量机制细节；
- 每次任务读索引约 5K+ token，且随条目数线性增长；
- 索引里应是“症状 + scope + tags + 链接”，细节留在 entry。

### P0：scope 太粗，缺少匹配门禁

- backend 有 37 条，任何后端任务都可能命中；
- 没有 `areas` / `symptoms` 字段，也没有“最多读 3 条”的约束；
- 只靠 `scope + tags` 不能保证“符合场景的一定被找到”，也不能避免“同 scope 无关条目全部加载”。

### P0：没有使用/影响记录

- 不知道哪些 entry 被读、读了之后是否改变测试/CR/设计；
- 没有 `last_used`、`use_count`、`status`；
- 无法区分“低频高价值”和“低频无用”。

### P1：spec 加载粒度过粗

- `phm/spec.md` 75K 字符，任务只需要几个 Requirement 区间；
- `_index.md` 只到“域 → 文件”，没有“域 → Requirement 区间/章节”的锚点；
- 结果是 BA/SA 整文件读，或靠 grep 猜位置。

### P1：spec 索引质量

- `_index.md` 有 `—` 占位、重复/错位行、旧命令名 `/harness-archive`；
- 已清理，详见第 6 节。

## 5. memory 设计决策

### 5.1 scope 是否放最前

**平表建议 scope 放第一列：**

```markdown
| scope | tags | 症状 / 触发 | entry |
```

分节索引则标题已是 scope，行首不必重复。

### 5.2 `scope + tags + 症状 + 链接` 能保证命中吗？

**不能。** 需要：

- `scope` 精确匹配；
- `tags` / `areas` / `symptoms` 至少命中一项；
- 单任务最多读 3 条；
- cold 作为兜底搜索；
- 高风险条目 `pinned: true`。

没有索引能保证 100% 命中；只能降低漏检概率。

### 5.3 hot / cold

- **hot**：`index.md`，默认只读，目标 20–30 条；
- **cold**：`cold.md`，默认不读，只在 hot 无匹配时搜索；
- **不删除**：cold 只是存储层级，entry 文件保留；
- **提升**：再次使用时 `memory_index.py touch <id>`；
- **降温**：60 天未使用或超过 hot 预算，且未 `pinned`；
- **退役**：只有人工确认后才标记 `retired`。
- 每个任务只读 hot index，cold 不进入默认上下文。

## 6. 已完成的改动

### memory hot/cold（iot-harnessKit）

- 新增 `.harness/memory/README.md`
- 新增 `.harness/memory/cold.md`
- 新增 `.harness/scripts/memory_index.py`
- 迁移结果：**66 条 → hot 30 / cold 36**
- `index.md`：21,132 → 6,044 字符
- `cold.md`：7,447 字符（默认不读）
- 36 条 entry 增加 `status: cold`；没有删除 entry
- `memory_index.py check`：PASS（hot=30, cold=36, entries=66）

### specs 清理

- 删除 `（更多能力在归档时自动添加）` 和 `—` frontmatter 占位说明
- 把误放在「跨域流程」下的 `数据编织` 归并到业务域表
- 删除重复的 `用户编程`、`告警引擎` 行
- `harness-archive` → `hk-archive`
- 删除 `设备管理`、`HMI 可视化` 两行（确认当前没有对应 spec 文件，不再保留占位域）
- 业务域表 10 行，所有 `对应 spec` 文件都存在

### PHM section index

- 在 `phm/spec.md` 的「核心实体」后新增「章节索引（导航）」
- 9 个 Requirement 区间：
  - R-001~006、007~013、014~018、019~025、026~032
  - R-033~041、042~051、052~057、058~065
- 只加导航和起始行号，**未改 Requirement/Scenario 内容**
- `spec_lint.py` 通过：10 文件 / 205 Requirement / 615 Scenario

## 7. 下一步

1. 人工复核 cold 36 条，高风险条目 `pinned: true` 或 `promote`；
2. 实际读取并起作用的条目归档时 `touch`，让未来降温基于真实使用；
3. 下个归档按新流程执行 `sync` / `cool --days 60 --max-hot 30 --apply` / `check`；
4. 观察 10 个任务后，再决定 hot 上限是否降到 20；
5. spec 侧下一步按 Requirement 区间读取，避免整文件加载。

## 8. 不做什么

- 不按“读取次数”直接删除条目；
- 不让每个任务默认读 cold index；
- 不为省 token 删除 spec 内容；
- 不做没有人工确认的自动退役；
- 不再手写 `memory/index.md`（由脚本生成）。
