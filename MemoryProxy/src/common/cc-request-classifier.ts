/**
 * Claude Code request classification — 基于 Anthropic body 的 `cache_control`
 * marker 位置 + tools/thinking 兜底，把 CC 客户端发到 /v1/messages 的所有请求
 * 三分成 main / fork / sidequery。
 *
 * 判定依据（源码硬约束 + 抓包实证）：
 *   - MAIN 主对话：cache_control marker 在 messages[n-1]（含 msgs=1 边界），
 *     但明确标记为 SUGGESTION/RECAP/COMPACT 等内部请求的内容除外
 *   - FORK 复用缓存（SUGGESTION/RECAP/COMPACT/...）：marker 在 messages[n-2]
 *     源码 forkedAgent.ts + claude.ts:3242-3243 强制 skipCacheWrite=true 挪
 *     marker 到 n-2 位置以避免误算 cache write cost
 *   - SIDEQUERY 独立请求（TITLE/verify_api_key/...）：无 marker + tools=[] +
 *     thinking.disabled；源码 sessionTitle.ts:434 + queryHaiku 强制关 caching
 *   - WebSearch 执行请求：单条 user 消息 + Anthropic web_search
 *     Provider Tool。它由 Claude Code 在客户端工具内部另行发起，不属于主对话。
 *
 * 3P provider 关缓存的兜底：body 全无 marker 时，用 tools=[] && thinking.disabled
 * 两条硬约束联合判 sidequery；否则保底 main —— 退化到原有一刀切逻辑，不会更糟。
 *
 * 详细设计与抓包实证见:
 *   docs/design/2026-07-30-cc-request-routing-plan.md
 */

import { isClaudeCodeInternalPrompt } from "./user-query-extractor.js";

export type CcRequestKind = "main" | "fork" | "sidequery";

/**
 * 根据 Anthropic 请求 body 判定请求类型。
 *
 * 输入是 handler 已解析的 body（Record<string, unknown>），字段访问全部走
 * 防御性 narrowing，未知/畸形 body 一律回退 "main" —— 保证判定失败时行为
 * 等价原有链路。
 */
export function classifyCcRequest(body: Record<string, unknown>): CcRequestKind {
  const msgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  const n = msgs.length;
  const markerIdx = findLastCacheControlIndex(msgs);

  // 主判定：cache_control marker 位置
  if (markerIdx >= 0) {
    // Suggestion/Recap/Compact 等请求会复用主对话缓存，但不是用户新提交
    // 的问题。它们需要读取完整历史，却不能注入或执行新的 Native Tool。
    if (isClaudeCodeInternalRequest(msgs)) return "fork";
    // messages[n-2] → FORK（skipCacheWrite=true 强制）
    if (markerIdx === n - 2) return "fork";
    // 其它位置（含 last=n-1）→ MAIN
    return "main";
  }

  // Claude Code 的 WebSearch 客户端工具会再发一条 Anthropic Provider Tool
  // 请求。它沿用会话请求头，却没有 UserPromptSubmit 标记，不能参与历史恢复。
  if (isClaudeCodeWebSearchSidequery(body)) return "sidequery";

  // 无 marker：可能是 SIDEQUERY，也可能是 3P provider 关 caching 的 MAIN
  // 兜底信号：SIDEQUERY 硬约束是 tools=[] AND thinking.disabled 同时命中
  //          用 && 而非 || 避免误伤"用户单独禁 tools 或单独禁 thinking"的主对话
  const toolsEmpty = !Array.isArray(body.tools) || (body.tools as unknown[]).length === 0;
  const thinking = body.thinking as { type?: string } | undefined;
  const thinkingOff = thinking?.type === "disabled";
  if (toolsEmpty && thinkingOff) return "sidequery";

  return "main";
}

function isClaudeCodeInternalRequest(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== "user") continue;
    const text = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
          .map((block) => {
            if (!block || typeof block !== "object") return "";
            const value = block as { type?: unknown; text?: unknown };
            return value.type === "text" && typeof value.text === "string" ? value.text : "";
          })
          .filter(Boolean)
          .join("\n")
        : "";
    return isClaudeCodeInternalPrompt(text);
  }
  return false;
}

export function isClaudeCodeWebSearchSidequery(
  body: Record<string, unknown>,
): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length !== 1) return false;
  const message = messages[0] as { role?: unknown } | undefined;
  if (message?.role !== "user") return false;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.length !== 1) return false;
  const tool = tools[0] as Record<string, unknown> | undefined;
  if (
    tool?.name !== "web_search"
    || typeof tool.type !== "string"
    || !/^web_search_\d{8}$/.test(tool.type)
    || Object.hasOwn(tool, "input_schema")
  ) {
    return false;
  }

  const toolChoice = body.tool_choice as Record<string, unknown> | undefined;
  return toolChoice?.type === "auto"
    || (toolChoice?.type === "tool" && toolChoice.name === "web_search");
}

/**
 * 在 messages 数组里找**最后一条**包含 cache_control marker 的 message 索引。
 *
 * cache_control 在 CC 客户端是塞在 content block 层（不是 message 顶层），
 * 所以要扫每条 message 的 content 数组里任意 block 是否含 cache_control 键。
 * 无匹配返回 -1。
 */
export function findLastCacheControlIndex(msgs: unknown[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { content?: unknown };
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as unknown[]) {
      if (b && typeof b === "object" && "cache_control" in (b as object)) return i;
    }
  }
  return -1;
}
