import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';

export interface RelayerIdentity { chainId: number; relayer: string }
const host = '127.0.0.1';
// Fixed protocol: changing this mapping or adding fallback ports breaks exclusion
// between old and new binaries. Keep it independent of DB, cwd, UID and HTTP port.
export function relayerOwnershipPort({ chainId, relayer }: RelayerIdentity): number {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(relayer)) throw new Error('Invalid relayer ownership identity');
  const digest = createHash('sha256').update(`gol-pay-relayer/v1:${chainId}:${relayer.toLowerCase()}`).digest();
  return 20000 + digest.readUInt32BE(0) % 40000;
}
// Retain the handle privately for the entire process lifetime. Never expose close,
// unlink a file, expire a lease, or release on completion of the startup callback.
const owners = new Set<Server>();

/** Single host/network namespace only. All writer processes must use this gate.
 * Hash/port collisions intentionally fail closed; there is no takeover or fallback.
 * The OS releases the exclusive bind when this process exits, including SIGKILL.
 */
export async function startOwnedRelayer<T>(identity: RelayerIdentity, start: () => T | Promise<T>): Promise<T> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Relayer ownership supports only macOS and Linux');
  const port = relayerOwnershipPort(identity);
  const server = createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  server.maxConnections = 1;
  await new Promise<void>((resolve, reject) => {
    let acquired = false;
    const fatal = () => {
      // Losing the kernel lock while continuing work is never recoverable here.
      console.error('Relayer ownership lost; terminating without takeover or retry');
      process.exit(1);
    };
    server.on('close', () => { if (acquired) fatal(); });
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (acquired) fatal();
      else reject(new Error(`Relayer ownership unavailable for chain ${identity.chainId}, account ${identity.relayer.toLowerCase()} at ${host}:${port} (${error.code ?? 'listen_error'}); another writer or port conflict. No work started.`));
    });
    server.listen({ host, port, exclusive: true, reusePort: false }, () => {
      acquired = true;
      owners.add(server);
      // The lock must not prevent an otherwise fully drained process from exiting.
      server.unref();
      resolve();
    });
  });
  return start();
}
