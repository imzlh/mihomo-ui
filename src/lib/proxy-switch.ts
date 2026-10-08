import type { MihomoClient } from './mihomo';
import type { Connection } from './types';

export function connectionsForProxySwitch(
  connections: Connection[],
  group: string,
  previous: string,
): Connection[] {
  const seen = new Set<string>();
  return connections.filter((connection) => {
    // Mihomo reports chains from the leaf back to the outermost group.
    const matches = connection.chains.some(
      (member, index) => member === group && index > 0 && connection.chains[index - 1] === previous,
    );
    if (!matches || seen.has(connection.id)) return false;
    seen.add(connection.id);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '无法清理旧连接';
}

export async function switchProxyWithCleanup(
  client: Pick<MihomoClient, 'proxy' | 'connections' | 'selectProxy' | 'closeConnection'>,
  group: string,
  name: string,
): Promise<{ closed: number; failed: number; error?: string }> {
  const [proxyResult, connectionsResult] = await Promise.allSettled([
    client.proxy(group),
    client.connections(),
  ]);
  const previous = proxyResult.status === 'fulfilled' ? proxyResult.value.now : undefined;
  const readFailure = [proxyResult, connectionsResult].find(
    (result) => result.status === 'rejected',
  );
  let error =
    previous === name
      ? undefined
      : readFailure
        ? errorMessage(readFailure.reason)
        : !previous
          ? '内核未返回代理组原成员，未清理旧连接'
          : undefined;
  const ids =
    previous && previous !== name && connectionsResult.status === 'fulfilled' && !error
      ? connectionsForProxySwitch(connectionsResult.value.connections, group, previous).map(
          (connection) => connection.id,
        )
      : [];

  await client.selectProxy(group, name);

  let closed = 0;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        if (id === undefined) return;
        try {
          await client.closeConnection(id);
          closed++;
        } catch (cause) {
          failed++;
          error ??= errorMessage(cause);
        }
      }
    }),
  );
  return { closed, failed, ...(error === undefined ? {} : { error }) };
}
