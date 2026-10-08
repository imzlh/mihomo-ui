import type { ProxyNode } from './types';

/** Group delay responses are aggregated, but the core records each node as it finishes. */
export async function withProxyDelayProgress<T>({
  members,
  url,
  readNodes,
  measure,
  onResult,
  isCurrent,
}: {
  members: readonly string[];
  url: string;
  readNodes: (signal: AbortSignal) => Promise<Record<string, ProxyNode>>;
  measure: () => Promise<T>;
  onResult: (name: string, delay: number) => void;
  isCurrent: () => boolean;
}): Promise<T> {
  const controller = new AbortController();
  const pending = new Set(members);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let baseline: Record<string, ProxyNode> | undefined;
  try {
    baseline = await readNodes(controller.signal);
  } catch {
    // A failed progress read must not prevent the actual measurement.
  }
  if (!isCurrent()) throw new DOMException('请求已取消', 'AbortError');
  const measurement = (node: ProxyNode | undefined) => {
    if (!node?.extra) return node?.history.at(-1);
    const time = node.extra[url]?.history?.at(-1)?.time;
    // URL-specific status failures can alter delay, but share the main record's timestamp.
    return time ? node.history.find((entry) => entry.time === time) : undefined;
  };
  const previous = new Map(members.map((name) => [name, measurement(baseline?.[name])?.time]));
  const poll = async () => {
    if (controller.signal.aborted || !isCurrent()) return;
    try {
      const nodes = await readNodes(controller.signal);
      if (controller.signal.aborted || !isCurrent()) return;
      for (const name of pending) {
        const latest = measurement(nodes[name]);
        if (latest && latest.time !== previous.get(name)) {
          pending.delete(name);
          onResult(name, latest.delay);
        }
      }                      
    } catch {
      // Transient polling errors leave the final group response authoritative.
    } finally {
      if (!controller.signal.aborted && isCurrent() && pending.size)
        timer = setTimeout(() => void poll(), 300);
    }
  };
  if (baseline && pending.size) timer = setTimeout(() => void poll(), 300);
  try {
    return await measure();
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
