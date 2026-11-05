# Single-active-relayer runtime ownership

`src/server.ts` acquires a process-lifetime lock for `(chain ID, relayer signing address)` before opening the runtime database, binding/recovering the durable writer, starting background jobs, or serving HTTP. The identity comes from the adapter's actual `AccountWriter`, not from a configurable lock name. Both live and FakeChain server modes participate. API/test `createApp` alone is not a standalone runtime and does not acquire the lock.

## Native mechanism and scope

`src/runtime-ownership.ts` exclusively binds a TCP listener on `127.0.0.1`. It serves no protocol and immediately closes connections. The fixed mapping is:

```
identity = "gol-pay-relayer/v1:" + chainId + ":" + lowercase(relayerAddress)
port = 20000 + first_uint32_big_endian(SHA256(identity)) % 40000
```

The kernel owns the bind for the lifetime of the process. There is no TTL, heartbeat, expiring lease, PID file, filesystem cleanup, or takeover attempt. A stopped/hung process retains ownership. Exit, SIGKILL, or crash releases it through normal OS resource cleanup. The lock's socket is private, never exposed to callers, and is not closed when the startup callback returns or rejects. Unexpected listener failure after acquisition terminates the process rather than allowing unowned writes.

This uses existing Node native networking on macOS/Linux, with `exclusive: true` and `reusePort: false`; no dependency or native addon was added. A file lock would require a stable shared inode/path and care around unlink/replacement; a PID file or timeout lease cannot establish the required lifetime exclusion. A loopback bind avoids those filesystem and lease failure modes. The listener is unreferenced so it does not keep an otherwise drained process alive.

**This is a single-host, single-network-namespace invariant, not a distributed lock.** Containers with separate network namespaces, separate machines, and processes bypassing this entrypoint do not participate. Container replicas must not share this relayer key across isolated namespaces. Host networking can share the lock namespace, but this is not a substitute for deployment coordination. The module fails closed on unsupported platforms.

All participating binaries must retain this exact mapping and bind behavior. It is independent of database path, working directory, OS user, API port, RPC URL, deployment address, and subscription version. Changing those settings cannot acquire a second writer for the same chain/account. Distinct identities may run concurrently when their mapped ports differ.

## Fail-closed collisions and rollout

The port space is finite. Different identities can hash to the same port, or an unrelated application may occupy it. Either case refuses startup; it cannot create two owners. There is deliberately no alternate port, configurable lock namespace, fallback file, automatic kill, or stale-owner deletion. A local process can deny availability by binding the port; this is cooperative deployment exclusion, not a security boundary against an actor that controls the host or possesses the signing key.

A refusal reports only the public chain/account and port. Operators can derive the port with `relayerOwnershipPort({ chainId, relayer })` using the public address, and inspect that listener using standard OS tools. Confirm the existing process/port allocation before making deployment changes. Do not alter the mapping or add a fallback to bypass a conflict.

**First rollout must stop every older, unpatched writer before starting the guarded runtime.** The new code cannot retroactively lock a running older binary. Future rollouts must wait for the old process to exit; readiness failure is not permission to start a second writer. This patch does not start, stop, or activate any deployed service.

## Shutdown and recovery

SIGTERM/SIGINT stop new scheduled ticks and close the HTTP listener. Existing requests/RPC operations retain ownership while they drain. The database is not closed underneath in-flight work. A ten-second unreferenced deadline terminates a hung process; it does not release ownership early. Repeated termination or SIGKILL likewise releases only by ending the owner process.

Ownership does not prove an RPC transaction was dropped. A transaction accepted before a crash can still mine later. Restart with the same durable operation journal/database and let existing recovery reconcile it; do not replace it with an empty database or resend automatically. Different DB paths are excluded while an owner is alive, but the lock is not a cross-database nonce/history recovery mechanism after that owner dies.

Standalone scripts, alternate server entrypoints, worker processes, and future writers using the same account must also call `startOwnedRelayer(identity, start)` before any write-capable initialization. Do not start a concurrent direct-send script alongside this service. The scope of this patch is the API runtime entrypoint; it does not modify chain adapters, writer recovery, indexer, keeper, or scripts.

## Local evidence

```
pnpm exec vitest run test/runtime-ownership.test.ts
pnpm typecheck
```

The process tests spawn real Node/tsx children using random synthetic public identities and isolated temporary marker paths. They import only the ownership module, never `server.ts`, a wallet, a chain adapter, or a runtime database. Tests cover simultaneous contenders with different DB paths, signer case normalization, blocked callbacks, SIGSTOP without heartbeat, harmless connect/disconnect, SIGKILL/restart, graceful drain until exit, unrelated port occupancy without takeover, and distinct identities.

No application ports 3000/3001, actual runtime, RPC, secret files, or transactions are involved. The loopback ownership ports used by the synthetic children are test-only and released by process exit. Current platform evidence is macOS; Linux uses the same Node/libuv exclusive-bind mechanism but needs its own CI run for platform-specific release evidence.
