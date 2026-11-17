# 全局通用编码约束（顶层底线）

> **说明**：具体的框架编码规范（如业务后端框架、React、Vue、Spring Boot）请查阅各子工程 `docs/CODE_STANDARDS.md`。
> 本文件规定**跨子工程协作**时必须遵守的底线。CR 审查「二、安全与健壮性」时，以本文件为最低基线，端级 CODE_STANDARDS.md 为具体标准。

## 1. 接口契约规范
- 子工程之间的接口字段必须使用 **camelCase**（禁止下划线 `snake_case`）。

## 2. 注入防护（硬红线）
- 禁止字符串拼接构造 SQL/命令/脚本。必须使用参数化查询或框架提供的安全 API（如 PreparedStatement、Filter API、EF Core LINQ、Prisma 参数化）。
- 前端禁止直接使用 `v-html` / `innerHTML` / `dangerouslySetInnerHTML`，除非经过 DOMPurify 等价清洗且有注释说明原因。

## 3. 资源释放
- 数据库连接、文件句柄、网络连接使用后必须显式释放（try-finally / try-with-resources / using / finally 钩子）。
- 前端事件监听、定时器必须在组件销毁时清理（beforeDestroy / unmounted / useEffect cleanup）。

## 4. 异常处理
- 禁止吞异常（空 catch 块）。捕获后至少记录日志；无法处理时向上抛出。
- 错误信息不得向用户暴露内部实现细节（SQL 语句、堆栈跟踪、文件路径）。

## 5. 日志规范
- 使用统一的日志封装（如 LogHelper、ILogger、自定义 logger service），禁止直接使用 `System.out.println` / `console.log` 裸写生产日志。
- 日志消息必须包含足够的上下文参数（key-value 对），便于检索和关联。

## 6. 线程安全与并发（如适用）
- 共享可变状态必须有同步机制保护。
- 异步/后台线程必须隔离上下文（如 Meta、HttpContext、AsyncLocal），执行完成后清理。

## 7. 缓存一致性（如适用）
- 写操作后必须刷新或失效相关缓存，禁止出现"写入成功但缓存仍返回旧数据"的情况。