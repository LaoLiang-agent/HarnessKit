---
domain: <域名>                              # 业务域名（_index.md 索引键）
summary: "<一句话域摘要>"
entities: [<核心实体>]                       # 核心业务实体列表
api_prefixes: ["/api/<prefix>"]             # API 路由前缀
prefix: <XXX>                               # 需求编号前缀（2-3 字母大写，如 ORD/PRD/DF）
id_max_r: 0                                 # 历史已分配 R 码数字上界（含退役）
id_max_s: 0                                 # 历史已分配 S 码数字上界（含退役）
retired: []                                 # 退役码列表（永久不得复用）
last_updated: "<任务名> /hk-archive <日期>"
---

## 概述

描述该业务域的核心职责和边界。

## 核心实体

| 实体 | 说明 |
|------|------|
| <EntityName> | <一句话> |

## 行为需求

<!--
  格式：
  ### Requirement: <标题> (<PREFIX>-R-<NNN>)
  SHALL <主语> <行为>。

  #### Scenario: <标题> (<PREFIX>-S-<NNN>)
  - GIVEN <前置状态>
  - WHEN <触发动作>
  - THEN <预期结果>
-->
