/** Stop a pending stream read on disconnect; remove the listener when this reader is done. */
export function cancelReaderOnAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): () => void {
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  return () => signal?.removeEventListener("abort", cancel);
}
