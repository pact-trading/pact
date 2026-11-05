import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, ViemChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { intentTypedData } from '../src/typed-data.js';
import { USDT } from '../src/approval.js';

const addresses = { router: toHex(1, { size: 20 }), escrow: toHex(2, { size: 20 }), subscription: toHex(3, { size: 20 }), gasTank: toHex(4, { size: 20 }) };
const signer = privateKeyToAccount(toHex(55, { size: 32 }));
function fixture() {
  const db = openDb(), keys = seedMerchant(db, signer.address), chain = new FakeChain(true);
  const relayer = new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription));
  const app = createApp({ db, chain, relayer });
  return { db, keys, chain, relayer, get: (query: string, key = keys.secretKey) => app.request(`/v1/fees/preview${query}`, { headers: { authorization: `Bearer ${key}` } }) };
}
describe('merchant fee preview and current Router policy', () => {
  it('quotes the current configured conversion with ceiling division and no writer mutation', async () => {
    const f = fixture(); f.chain.price = 1_000_000_001n; f.chain.policy.usdtPerWbt = 3_000_007n;
    const response = await f.get('?maxGas=300000', f.keys.publishableKey);
    expect(response.status).toBe(200);
    const body = await response.json(), maximum = 340000n * f.chain.price;
    expect(body).toMatchObject({ chainId: 1874, targetGas: 300000, gasPriceWei: String(f.chain.price), usdtPerWbtMinor: '3000007', maximumReimbursementWei: String(maximum), minimumFeeMinor: String((maximum * 3_000_007n + 10n ** 18n - 1n) / 10n ** 18n) });
    expect(f.chain.writer.rows()).toHaveLength(0); expect(f.chain.sent).toHaveLength(0);
  });
  it('fails on invalid input, changed limits or unavailable policy without a fabricated default', async () => {
    const f = fixture();
    for (const query of ['?maxGas=0', '?maxGas=1.5', '?maxGas=-1', '?maxGas=1000001', '?maxGas=abc']) expect((await f.get(query)).status).toBe(422);
    f.chain.policy.maxGasPerCall = 100000n; expect((await f.get('?maxGas=200000')).status).toBe(422);
    f.chain.policy.maxGasPriceWei = 1n; expect((await f.get('?maxGas=100000')).status).toBe(422);
    vi.spyOn(f.chain, 'routerPolicy').mockRejectedValue(new Error('private RPC detail'));
    const failure = await f.get('?maxGas=100000'); expect(failure.status).toBe(503); expect(await failure.text()).not.toContain('private RPC detail');
    expect(f.chain.writer.rows()).toHaveLength(0);
  });
  it('revalidates the actual conversion quote before submit rather than accepting a stale cheap fee', async () => {
    const f = fixture();
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [toHex(9, { size: 32 }), signer.address, 2_000_000n, 2592000n] });
    const intent = { signer: signer.address, merchant: signer.address, target: addresses.escrow, dataHash: keccak256(data), amount: 2_000_000n, feeUSDT: 1000n, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 120), maxGas: 300000 };
    const request = { intent, data, signature: await signer.signTypedData(intentTypedData(intent, addresses.router)) };
    f.chain.policy.usdtPerWbt = 100_000_000n;
    await expect(f.relayer.submit(request)).rejects.toMatchObject({ code: 'fee_too_low' });
    expect(f.chain.sent).toHaveLength(0);
    f.chain.policy.usdtPerWbt = 1_000_000n;
    await expect(f.relayer.submit(request)).resolves.toMatch(/^0x/);
  });
});
describe('block-pinned merchant chain reads', () => {
  it('reads balance and all policy getters at a specific block and rejects the wrong token', async () => {
    const adapter = new ViemChain('http://unused.invalid', toHex(123, { size: 32 }), addresses);
    let token = USDT, decimals = 6;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => ({ usdt: token, decimals, balanceOf: 900719925474099312345678n, usdtPerWBT: 7_000_000n, maxGasPerCall: 800000, maxGasPrice: 50_000_000_000n, minAmount: 500000n })[functionName]);
    Object.assign(adapter, { public: { getChainId: async () => 1874, getBlockNumber: async () => 123n, readContract } });
    expect(await adapter.merchantBalance(signer.address)).toMatchObject({ balanceMinor: 900719925474099312345678n, blockNumber: 123n, token: USDT });
    expect(await adapter.routerPolicy()).toMatchObject({ usdtPerWbt: 7_000_000n, maxGasPerCall: 800000n, minimumAmountMinor: 500000n, blockNumber: 123n });
    expect(readContract.mock.calls.every(([args]) => (args as { blockNumber?: bigint }).blockNumber === 123n)).toBe(true);
    token = toHex(99, { size: 20 }); await expect(adapter.merchantBalance(signer.address)).rejects.toThrow('token');
    token = USDT; decimals = 18; await expect(adapter.merchantBalance(signer.address)).rejects.toThrow('decimals');
  });
});
