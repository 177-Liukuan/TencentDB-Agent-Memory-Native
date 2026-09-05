# Native / Client 连续调用检查与修复

日期：2026-09-05。检查对象：当前 Native MemoryProxy，不改 Baseline 工具逻辑、Memory/Skill 业务逻辑或 Hook。首次检查修复了三个续写问题；用户确认后，又为长期记录补充一个客户端调用 ID，修复下一次请求中的历史错序。

## 1. 已复现并修正的三个问题

### 纯客户端轮错误地写入 Native 历史

过程：Native 查询完成 → 模型要求执行 Bash → Claude Code 返回 Bash 结果。

`resumeClientToolResults()` 原先只检查是否配置了长期存储，随后直接调用 `buildNativeToolLedgerRound()`。但这一轮只有 Bash，没有 Native 调用，后者拒绝生成记录，导致 503。

现在增加本轮存在 `owner === "proxy"` 的条件。纯客户端轮仍保存短期状态、恢复之前的完整消息、使用首次请求的目标和配置；只是不会新增无意义的 Native 长期记录。Bash 成功与失败两种结果都已覆盖。

### 历史保存失败后，立即重试被 409 拦住

原顺序：保存客户端结果 → 领取模型续写执行权 → 写长期历史 → 请求模型。若历史写入失败，模型尚未收到请求，但状态已变为 `resuming`。

现在先写长期历史，再领取模型续写执行权。历史写入按同一个记录 ID 幂等处理；数据库恢复后可立即重试，不必等执行权过期。测试包含“完全没写入”和“已经写入、但确认响应丢失”两种故障，均只产生一份有效历史、一次模型请求，不重复执行工具。

这一修改不释放已经发出上游请求的执行权。网络中断时，上游可能仍在处理，仍沿用原有到期重试规则，避免立刻并发发出第二份请求。旧版本已经留下的 `resuming` 状态也不会被此改动自动清除。

### 后续纯客户端轮未被作为原工具循环继续处理

过程：Native → Client 1 → Client 2 → Native → 最终回答。

Anthropic 的 `handleRound()` 原先一律把入口当作外部首轮，导致 Client 1 回填后直接生成的 Client 2 被普通回放。OpenAI 共用 Coordinator 中，Native 之后的纯客户端轮也直接走回放或最终回答分支；Responses 包括 Claude Code 转码路径同样受影响。

现在使用已有的 `parentStateKey` 判断客户端结果续写，并让内部纯客户端轮进入现有短期状态保存、客户端下发、结果恢复流程。没有新增状态或抽象层。外部首次请求只有客户端工具时，仍保持原有回放行为。

上述三个续写问题的业务修改涉及：

- `MemoryProxy/src/native-proxy-tools/client-tool-resume.ts`
- `MemoryProxy/src/native-proxy-tools/tool-loop-coordinator.ts`
- `MemoryProxy/src/native-proxy-tools/openai-tool-loop-coordinator.ts`

## 2. 测试情况

先增加失败用例，旧实现出现 9 个失败，分别覆盖上述三类问题和不同协议；修复后全部通过。随后增加连续 HTTP 请求和真实 ClickHouse 检查。

| 情况 | 本次结果 |
|---|---|
| 无工具、外部首轮只有 Client Tool | 原有回放行为保持 |
| 纯 Native 完成后请求原模型 | 通过，原目标、System、Tools 保持 |
| Native → 纯 Client，Client 返回成功或错误 | 已修复，均可继续，不写空 Native Ledger |
| 连续多个 Client 轮 | 已修复，保留后续轮次恢复状态 |
| Anthropic / Chat Completions / Responses 下发与解析 | 相关回归通过，Claude Code 的 Responses 转码路径亦覆盖 |
| 混合轮中 Client 先完成、Native 后完成 | 等待 Native 结果后合并，不提前请求模型 |
| 同名多调用、结果乱序 | 按调用 ID 区分，按调用顺序合并 |
| Native 失败、Client 错误、空字符串和空数组结果 | 保留错误标记与结果内容，不重复执行已完成工具 |
| 相同客户端结果重复或并发提交 | 执行权防止同时请求模型；完成后重放保存的响应 |
| 结果冲突、缺少结果、已下发组中夹杂未知 ID | 拒绝处理，不接受半份结果 |
| 尚未下发或已中断的状态 | 不领取该状态，不接受结果；无匹配的已下发记录时返回 `not_applicable`，交回普通请求流程，并非一律返回 4xx |
| 原 Native 执行实例退出、执行权过期 | 已有恢复测试通过 |
| 已知短期记录过期 | 返回过期错误，不声称能恢复已被删除的执行状态 |
| 流式响应中断 | 不把未完成响应当作完整一轮；已有相关测试通过 |
| 重启后接收 Client 结果、已保存响应的重复交付 | 通过 |

新增 HTTP 入口测试运行两种序列：

1. Native → Client 1 → Client 2 → Native → 最终回答；
2. Native + Client 1 → Client 2 → Native → 最终回答。

每次客户端回填前重新创建运行实例，复用保存的数据。每次回填完成后又重复提交一次，确认不会增加模型请求。最终上游请求中四个 Tool Call 与四个结果按相同顺序各出现一次；客户端响应不包含 Native 调用 ID 或工具定义。

这里使用真实 HTTP Handler、解析器、Coordinator 和恢复代码，但模型与工具执行返回测试数据，内存存储后端模拟跨实例数据共享。不是实际启动 Claude CLI 调用 DeepSeek 的人工测试。

真实 ClickHouse 另外启用 `NATIVE_TOOL_CLICKHOUSE_TEST=1`，使用临时测试表。新增“纯 Client 轮跨实例恢复、保存响应、另一实例重放”的测试；执行表与 Ledger 现有测试也全部运行。没有修改业务数据。

首次续写修复的验证结果：

- `npm run typecheck`：通过。
- 全量 Vitest：53 个文件，454 项通过，0 项跳过，其中真实 ClickHouse 8 项。
- `git diff --check`：本次恢复修复无空白错误。

## 3. 经确认后补充修复的历史排序问题

必须区分两个阶段：

- 当前用户请求尚未结束：从短期请求快照恢复，前述连续调用测试已经通过。
- 下一次新的用户请求：从长期 Ledger 补回隐藏内容，发现以下顺序错误。

最小例子：第 1 轮 Native A，第 2/3 轮只有客户端工具，第 4 轮 Native B。客户端保留两个客户端调用，长期表保存 Native A/B。原 `reconstructAnthropicToolLedger()` 只根据混合轮中的 Client 引用确定相邻位置，没有把独立的纯 Client 轮纳入定位。

```text
正确：Native A → Client 1 → Client 2 → Native B
修复前实测：Native A → Native B → Client 1 → Client 2
```

复现命令（在 Native 的 `MemoryProxy` 目录执行）：

```bash
node --import tsx/esm scripts/qa/reproduce-native-client-history-order.ts
```

该脚本修复前输出 `passed: false`，退出码 1。现已按新记录结构补充位置，输出 `passed: true`，退出码 0。相同问题也加入 Vitest 和 HTTP 入口测试，不再只靠独立脚本检查。

不能直接把所有缺失 round 都当成客户端轮：进入 Native 处理之前也可能已有普通客户端调用，而新的外部请求进入 Coordinator 时 round 会重新起算。只数当前消息或使用 round 差值，未必能够区分 Native 原来发生在这些客户端调用之前还是之后。

### 实际修复

用户确认采用“保存这段 Native 历史前面最近一次客户端工具调用 ID”的办法。新增 `previousClientToolCallId`，随现有请求快照和长期记录保存：

- 字符串：恢复到该客户端调用结果所在的 User 消息之后。
- `null`：已确认当前用户问题后尚未发生客户端调用，恢复到该用户问题之后。
- 缺省：旧版本没有记录位置，不能视为已确认“没有前置客户端调用”。

首次进入工具处理时，从 Hook 已确定的当前 Turn 范围内读取原始客户端消息，只查 `tool_use` 与 `tool_result` 的 ID，不扫描 reminder 或用户文字。保存的位置不包含 MemoryProxy 本次恢复的隐藏内容。内部连续 Native 调用沿用这个位置；每次客户端结果收齐并续写后，将位置更新为本次客户端调用的 ID。

历史恢复先在客户端原始消息中确定所有位置，再补充混合回复的 Native 内容，最后从后向前插入纯 Native 回复。同一位置的多条 Native 记录按原模型续写顺序排列。不同工具即使同名，也按调用 ID 区分；混合记录使用已有 `ledgerId` 对应位置，不再把可能重新从 1 开始的 `round` 当作记录唯一编号。

没有增加 Hash、checkpoint、Hook 事件或另一套恢复器，也没有在长期表保存客户端工具的完整参数和结果。

主要代码：

- `MemoryProxy/src/anthropicHandler.ts`、`native-proxy-tools/exact-target-transport.ts`：保存首次请求的客户端位置，不把该字段加入模型请求正文。
- `MemoryProxy/src/native-proxy-tools/client-tool-resume.ts`：客户端结果完成后，更新后续 Native 调用的位置。
- `MemoryProxy/src/native-proxy-tools/tool-ledger-round.ts`：将位置连同真实 Native 结果保存到长期记录。
- `MemoryProxy/src/native-proxy-tools/tool-history-reconstructor.ts`：按客户端调用 ID 找结果位置并恢复内容。
- `MemoryProxy/src/db/clickhouse-native-tool-ledger-storage-adapter.ts`：新增列及读写；`tool-execution-storage-adapter.ts` 同步允许和校验快照字段。

### 数据升级与边界

正常启动时通过 `ADD COLUMN IF NOT EXISTS` 给 Ledger 增加 `previous_client_tool_call_id Nullable(String)`。SQL `NULL` 表示旧记录位置未知，空字符串表示已确认位于用户问题后，其余值为客户端调用 ID。执行状态表、执行超时和压缩版本规则不变。

不自动修改旧记录。如果旧的纯 Native 记录所在 Turn 含有客户端工具，系统返回 `409 native_tool_history_conflict`，不会继续按旧规则猜测位置；旧记录所在 Turn 没有客户端调用时仍可在用户问题后恢复。同一条回复内混合工具的旧记录仍可使用原有客户端引用恢复。

因此，本次修复保证新生成记录的位置完整，不声称能自动补救所有旧会话。旧会话如果缺少位置，不能靠升级补列变成已知位置；也不要把“先 compact 一次”当作无损迁移办法。这里没有加入自动回查短期状态或重写旧表的迁移功能。

新记录引用的客户端调用或结果缺失、重复、落在另一用户 Turn 时，同样返回冲突，不借用其他位置。Hook 丢失、branch/fork 继承等既有边界没有在本次扩展。

### 补充验证结果

先新增测试，在旧实现上观察到 15 项失败，包括两项完整 HTTP 请求中的错序；随后修复并增加持久化、协议和边界测试。

- 原错序脚本：通过，恢复为 `Native A → Client 1 → Client 2 → Native B`。
- Anthropic HTTP 入口：分别验证纯 Native 开始和混合调用开始，连续客户端回填、重建运行实例、移除短期状态后，再提交下一条用户问题；调用和结果按相同顺序各出现一次。
- Anthropic 客户端 / Responses 上游：验证 `Client → Native → Client → Native`，覆盖首次 Native 前已有普通 Client 调用、持久化续写及后续普通请求；客户端不接收隐藏的 Native 调用。
- 白盒测试：同名多调用、同一位置多段 Native、重新从 1 开始的 round、两个 round 相同的混合回复、缺失/重复/跨 Turn ID、旧数据未知位置、User 消息中的提醒保留。
- 真实 ClickHouse：在旧结构表里先写旧记录，验证正常启动自动补列且不改变旧记录；新位置跨实例读写和重复保存后仍能正确恢复。不触碰业务表。
- 最终 `NATIVE_TOOL_CLICKHOUSE_TEST=1` 全量 Vitest：**53 个文件，481 项通过，0 项跳过，其中真实 ClickHouse 10 项**。
- `npm run typecheck`、`git diff --check`：通过。

HTTP 集成测试的模型与 Bridge 返回受控测试数据，未实际启动 Claude CLI 或调用 DeepSeek 云端服务。本轮没有重跑评测实验，也没有部署到正在运行的 Native 服务。

## 4. 本次提交与运行状态

按中途追加要求，评测埋点已单独提交：

- Baseline：`de3f1cc feat(proxy): record bridge tool calls for evaluation`。
- Native：`0b99099 feat(proxy): record bridge tool calls for evaluation`。

埋点测试分别 6/6、7/7 通过。Native 类型检查通过；Baseline 类型检查存在 6 处旧错误，另取提交前 HEAD 源码验证，同样出现 `RequestKind`、`traceId`、`memCommand`、`cost-guard` 类型或模块错误，本次没有顺带修改。

工具恢复修复及其测试保留在 Native 工作区，未混入埋点提交；未推送远端，未更新根仓库子模块指针，也未重启生产服务。现场旧会话是否恢复，需要后续部署修复后另行验证。
