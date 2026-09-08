# Native 工具状态查询 503 修复

## 原因

延迟实验 `latency-2026-09-08T17-44-55-393Z` 中，Native 返回
`503 Native Proxy Tool state is temporarily unavailable`。服务没有掉线；失败的是
`tdai_native_tools.native_proxy_tool_execution_state` 上的状态查询。

原失败查询 ID：`520b6b2b-81b6-4e49-a619-d9a84f58de31`（2026-09-08 18:07:09 UTC）。
ClickHouse 版本为 `25.12.11.4`，异常为：

```text
Not found column _block_number in block. There are only columns:
MergeTreePatchReaderJoin::readPatches
```

该表通过轻量 UPDATE 保存执行状态。数据分片合并后，尚未物化的更新补丁需要按内部行编号匹配。
当前版本在同时使用延迟物化（lazy materialization）时，补丁读取路径拿不到所需的
`_block_number`，导致带 `ORDER BY updated_at DESC LIMIT 1` 的状态查询失败。
不是建表漏列：表设置和实际数据分片中均已存在该内部列。

## 最小修复

仅在 `ClickHouseToolExecutionStorageAdapter.queryRows()` 发出的查询中设置：

```text
query_plan_optimize_lazy_materialization = 0
```

查询仍应用更新补丁，保留原有 WHERE、排序、LIMIT、身份隔离和过期条件；更新时的
版本比较、执行权、重放和续接逻辑不变。没有切换数据库、升级 ClickHouse、修改表结构，
也没有关闭全局查询优化。Ledger、Langfuse、Baseline 和工具描述均未修改。

关闭 `apply_patch_parts` 虽然也能绕过错误，但可能读到旧状态，因此不作为修复。
本次局部设置可能增加状态查询的列读取量，不能据此声称延迟毫无变化；尚未重跑延迟评测。

## 验证

- 在随机命名的独立测试表上，写入状态、连续更新三次，再合并源分片；测试专用的
  `apply_patches_on_merge = 0` 用于确定性地保留补丁，模拟更新与合并交错，不依赖等待或概率竞争。
- 修复前，新增回归测试在 `findByCallId()` 稳定复现同样的 `_block_number` 异常。
- 修复后，通过另一 Adapter 实例读取，得到版本 3 和最后一次更新的完整内容；`get()` 也通过。
  因此测试不仅验证“不报错”，还会阻止以忽略补丁、返回旧数据的方式绕过故障。
- 原实验失败查询也通过修正后的 Adapter 只读验证，成功找到对应状态；没有恢复该会话或调用模型。
- 原查询的 EXPLAIN 包含 `JoinLazyColumnsStep` 和 `LazilyReadFromMergeTree`；局部关闭延迟物化后
  不再走这一路径，排序和 LIMIT 仍保留。
- Native MemoryProxy 全量测试：54 个文件、527 项通过。其中 11 项连接真实 ClickHouse，
  覆盖并发领取执行权、重复创建、跨实例续接、结果重放、快照更新竞争和历史恢复。
  其余恢复、过期与协议测试一并通过。`npm run typecheck`、`git diff --check` 通过。

真实数据库回归入口：

```bash
NATIVE_TOOL_CLICKHOUSE_TEST=1 \
NATIVE_TOOL_CLICKHOUSE_URL=http://127.0.0.1:8123 \
NATIVE_TOOL_CLICKHOUSE_DATABASE='<测试数据库>' \
NATIVE_TOOL_CLICKHOUSE_USER='<测试用户>' \
NATIVE_TOOL_CLICKHOUSE_PASSWORD='<密码>' \
npm test -- scripts/qa/__tests__/clickhouse-native-tool-state.integration.test.ts
```

凭据应通过环境变量注入，不写入版本库。测试只修改并清理随机命名的测试表。

## 生效范围

2026-09-08 18:31:40 UTC 已重启 `tdam-native-proxy.service`，随后健康检查返回
`nativeProxyTools.ready = true`。Baseline、Core 和 ClickHouse 未重启；实验保持停止。
旧实验结果及失败证据保留，不追改为成功。本次未提交或推送代码。
