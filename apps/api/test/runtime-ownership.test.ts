import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { relayerOwnershipPort, startOwnedRelayer } from '../src/runtime-ownership.js';
const children: ChildProcess[] = [], directories: string[] = [];
const fixture = fileURLToPath(new URL('./fixtures/ownership-process.ts', import.meta.url));
const apiRoot = fileURLToPath(new URL('..', import.meta.url));
function identity() { return { chainId: 1874, relayer: `0x${randomBytes(20).toString('hex')}` }; }
// Select an unused synthetic identity before each test, outside the ephemeral
// client-port range. Production never changes identity/port on a bind conflict.
async function availablePort(id: ReturnType<typeof identity>) {
  if (relayerOwnershipPort(id) >= 30000) return false;
  const probe = createServer();
  const available = await new Promise<boolean>(resolve => {
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port: relayerOwnershipPort(id), exclusive: true }, () => resolve(true));
  });
  if (available) await new Promise<void>(resolve => probe.close(() => resolve()));
  return available;
}
async function availableIdentity() {
  for (let n = 0; n < 1000; n++) { const id = identity(); if (await availablePort(id)) return id; }
  throw new Error('No available synthetic ownership identity');
}
function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>(resolve => child.once('exit', () => resolve()));
}
function launch(id: ReturnType<typeof identity>, database = 'one.sqlite') {
  const directory = mkdtempSync(join(tmpdir(), 'gol-owner-test-')); directories.push(directory);
  const marker = join(directory, 'started');
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, String(id.chainId), id.relayer, marker], {
    cwd: apiRoot, env: { PATH: process.env.PATH, DATABASE_PATH: join(directory, database) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
  const result = new Promise<{ status: string; message?: string; db?: string }>((resolve, reject) => {
    child.once('message', message => resolve(message as { status: string }));
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Child exited before ownership result: ${code}/${signal}: ${stderr}`)));
  });
  return { child, result, marker };
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited(child); }));
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});
// These integration cases start several real Node/tsx processes sequentially.
// Keep a finite deadline while allowing shared CI/dev hosts to schedule them;
// the ownership assertions and production lock have no timing-based relaxation.
describe('single-host relayer process ownership', { timeout: 15_000 }, () => {
  it('normalizes signer case and validates identity before starting work', async () => {
    const id = identity();
    expect(relayerOwnershipPort(id)).toBe(relayerOwnershipPort({ ...id, relayer: `0x${id.relayer.slice(2).toUpperCase()}` }));
    for (const invalid of [{ ...id, chainId: 0 }, { ...id, chainId: 1.5 }, { ...id, relayer: 'not-an-address' }]) {
      let ran = false;
      await expect(startOwnedRelayer(invalid, () => { ran = true; })).rejects.toThrow('identity');
      expect(ran).toBe(false);
    }
  });
  it('allows exactly one competing process even with different DB paths', async () => {
    const id = await availableIdentity();
    const contenders = Array.from({ length: 4 }, (_, i) => launch(id, `${i}.sqlite`));
    const results = await Promise.all(contenders.map(c => c.result));
    expect(results.filter(r => r.status === 'owned')).toHaveLength(1);
    expect(results.filter(r => r.status === 'blocked')).toHaveLength(3);
    contenders.forEach((c, i) => expect(existsSync(c.marker)).toBe(results[i].status === 'owned'));
    const duplicate = launch({ ...id, relayer: `0x${id.relayer.slice(2).toUpperCase()}` }, 'other.sqlite');
    expect(await duplicate.result).toMatchObject({ status: 'blocked' });
    expect(existsSync(duplicate.marker)).toBe(false);
  });
  it('keeps ownership during SIGSTOP and harmless connections; crash releases it for restart', async () => {
    const id = await availableIdentity(), owner = launch(id);
    expect((await owner.result).status).toBe('owned');
    const socket = createConnection({ host: '127.0.0.1', port: relayerOwnershipPort(id) });
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => { socket.destroy(); resolve(); }); socket.once('error', reject); });
    owner.child.kill('SIGSTOP');
    expect((await launch(id, 'second.sqlite').result).status).toBe('blocked');
    // A frozen event loop cannot heartbeat; ownership must never expire anyway.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await launch(id, 'third.sqlite').result).status).toBe('blocked');
    owner.child.kill('SIGKILL'); await exited(owner.child);
    const restarted = launch(id, 'restart.sqlite');
    expect((await restarted.result).status).toBe('owned');
    expect(existsSync(restarted.marker)).toBe(true);
  });
  it('retains ownership through graceful drain until the process exits', async () => {
    const id = await availableIdentity(), owner = launch(id);
    expect((await owner.result).status).toBe('owned');
    const draining = new Promise(resolve => owner.child.once('message', resolve)); owner.child.send('drain'); await draining;
    expect((await launch(id, 'drain-contender.sqlite').result).status).toBe('blocked');
    owner.child.send('finish');
    await exited(owner.child);
    expect((await launch(id, 'after-exit.sqlite').result).status).toBe('owned');
  });
  it('fails closed on unrelated port occupancy without evicting it or falling back', async () => {
    const id = await availableIdentity(), occupied = createServer(socket => socket.end());
    await new Promise<void>((resolve, reject) => { occupied.once('error', reject); occupied.listen({ host: '127.0.0.1', port: relayerOwnershipPort(id), exclusive: true }, resolve); });
    try {
      const contender = launch(id);
      expect(await contender.result).toMatchObject({ status: 'blocked' });
      expect(existsSync(contender.marker)).toBe(false);
      expect(occupied.listening).toBe(true);
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
  it('permits different identities with distinct ownership ports', async () => {
    const first = await availableIdentity();
    let otherSigner = await availableIdentity();
    while (relayerOwnershipPort(otherSigner) === relayerOwnershipPort(first)) otherSigner = await availableIdentity();
    let otherChain = { ...first, chainId: first.chainId + 1 };
    while ([relayerOwnershipPort(first), relayerOwnershipPort(otherSigner)].includes(relayerOwnershipPort(otherChain)) || !await availablePort(otherChain)) otherChain.chainId++;
    const results = await Promise.all([first, otherSigner, otherChain].map(id => launch(id).result));
    expect(results.map(r => r.status)).toEqual(['owned', 'owned', 'owned']);
  });
});
