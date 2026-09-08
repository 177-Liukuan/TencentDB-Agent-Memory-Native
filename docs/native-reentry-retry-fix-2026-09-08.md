# Native 续写失败后的 409／502 恢复修复

## 问题

延迟实验 `latency-2026-09-08T18-42-55-065Z` 暴露了两种错误处理：

- `task-03-r2-native`：上游续写先失败，批次仍为 `resuming`。执行权到 19:25:32 才过期，客户端在 19:18:02 就已耗尽重试，连续收到 409。
- `task-05-r4-native`：19:24:10 检测到上游流缺少有效的 `message_stop`，将 502 保存为已完成结果；后续重试直接回放同一个错误，续写尝试数始终为 1。

首次上游故障的底层原因尚未完全定位；本次解决的是失败被执行状态持续放大的问题，不声称能消除网络或模型服务故障。

## 修改

1. 上游请求在交给工具协调器之前失败：保留已接受的工具结果，按版本及租约持有者原子释放执行权，下一次客户端重试可立即续写。
2. 协调器首次续写遇到断流／不完整流或上游 5xx、429，且未观察到新 Native 调用：释放执行权，不保存成固定回放的错误。不额外增加代理重试循环。
3. 已产生新 Native 调用、多轮内部执行，或其他不可安全重试的错误：仍保留终止结果，并返回 `x-should-retry: false`，避免盲目重复执行。该策略有意保守，包括只读的新 Native 调用也不自动重跑整段。
4. 成功回放、客户端派发结果、取消终止、租约过期接管及长期 Ledger 保持原有规则。旧执行者不能释放新执行者的租约。

没有改表结构、全局 ClickHouse 配置、工具定义、提示词、评分或 Baseline。没有重写旧实验的状态或结果。

## 复现与验证

先在旧代码中复现：同一份 Tool Result 第二次提交分别得到 409 和旧 502，预期恢复为 200 的测试均失败。修复后：

| 模拟操作 | 结果 |
| --- | --- |
| 真实 HTTP 提交任务、回填工具结果，第一次上游请求抛错，再提交相同结果 | 502 → 200；已完成 Native 工具仅执行一次 |
| 真实 HTTP 回填后，上游 SSE 缺少 `message_stop`，再提交相同结果 | 502 → 200；成功后再提交直接回放成功结果 |
| 使用同一个真实 ClickHouse 测试表，从另一适配器实例重试 | 无需等待 640 秒租约即可恢复 |
| 两个实例同时重试 | 只有一方获得续写权；另外一方不能重复请求模型 |
| 旧持有者或旧版本试图释放执行权 | 拒绝，不影响新持有者 |
| 新 Native 工具已开始后再遇到断流 | 保留终止错误，不重新执行工具 |
| 执行者失联而非已知失败 | 仍需租约到期才允许接管 |

测试使用本地 HTTP 客户端和真实代理入口，模型故障由可控替身注入；真实 ClickHouse 使用独立随机测试表，结束后清理。不调用 LLM、不修改评测 Agent 或工作区。

验证结果：MemoryProxy 54 个测试文件、534 项测试全部通过，包含 13 项真实 ClickHouse 测试；`npm run typecheck` 与 `git diff --check` 通过。

相关用例：

- `MemoryProxy/src/__tests__/anthropic-native-proxy-tool.integration.test.ts`：`recovers from ... on Client continuation without repeating tools`
- `MemoryProxy/src/native-proxy-tools/__tests__/client-tool-resume.test.ts`：立即重试、旧租约隔离、过期接管、新 Native 调用后的终止保护
- `MemoryProxy/scripts/qa/__tests__/clickhouse-native-tool-state.integration.test.ts`：`recovers ... across ClickHouse instances and fences stale owners`
