// Manual compaction that survives pi's RPC client giving up on slow replies.

/** The slice of pi's RpcClient that compaction needs. */
export interface CompactingChild {
  compact(instructions?: string): Promise<{ tokensBefore?: number; estimatedTokensAfter?: number } | undefined>;
  onEvent(listener: (event: unknown) => void): () => void;
}

/** pi answers `compact` after the summary is written, but its RPC client gives up on any reply after 30s. */
export const COMPACT_WAIT_MS = 10 * 60_000;

/**
 * Compact, riding out the client's 30s reply timeout: compaction keeps running in
 * pi, so on that timeout wait for its compaction_end event instead of failing.
 */
export async function compactAndWait(
  child: CompactingChild,
  instructions: string | undefined,
  waitMs = COMPACT_WAIT_MS,
): Promise<{ tokensBefore?: number; estimatedTokensAfter?: number } | undefined> {
  type End = { aborted?: boolean; errorMessage?: string; result?: { tokensBefore?: number } };
  let stop = () => {};
  const ended = new Promise<End>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for compaction to finish")), waitMs);
    const off = child.onEvent((event) => {
      if ((event as { type?: string }).type === "compaction_end") {
        resolve(event as End);
      }
    });
    stop = () => {
      clearTimeout(timer);
      off();
    };
  });
  ended.catch(() => {}); // only awaited on the timeout path below
  try {
    return await child.compact(instructions);
  } catch (err) {
    if (!/^Timeout waiting for response to compact/.test(err instanceof Error ? err.message : "")) {
      throw err;
    }
    const end = await ended;
    if (end.errorMessage || end.aborted || !end.result) {
      throw new Error(end.errorMessage ?? "compaction was aborted");
    }
    return { tokensBefore: end.result.tokensBefore };
  } finally {
    stop();
  }
}
