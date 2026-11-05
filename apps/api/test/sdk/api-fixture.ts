// Entirely in-process: synthetic signer, in-memory SQLite, FakeChain, no RPC/listener.
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { openDb, seedMerchant } from '../../src/db.js';
import { FakeChain, escrowAbi, subscriptionAbi } from '../../src/chain.js';
import { createApp } from '../../src/app.js';
import { Relayer, allowedTargets } from '../../src/relayer.js';
import { Indexer } from '../../src/indexer.js';
import { ApprovalService, APPROVER, USDT } from '../../src/approval.js';
import { intentTypedData } from '@pactagent/core';
export { Indexer, APPROVER, USDT };
export const signer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
export const merchantSigner = privateKeyToAccount(`0x${'3'.repeat(64)}`);
export const subscriptionV2: Address = '0x0000000000000000000000000000000000000005';
export const router: Address = '0x0000000000000000000000000000000000000001';
export const escrow: Address = '0x0000000000000000000000000000000000000002';
export const subscription: Address = '0x0000000000000000000000000000000000000003';
export function apiFixture(autoSettle = true, approvalEnabled = false, subscriptionVersion: 1 | 2 = 1, merchantAddress: Address = signer.address) {
  const db = openDb();
  const chain = new FakeChain(autoSettle, subscriptionVersion);
  const subscriptionAddress = subscriptionVersion === 2 ? subscriptionV2 : subscription;
  chain.tank.set(merchantAddress.toLowerCase(), { balanceWei: 10n ** 18n, dailyCapWei: 10n ** 18n, spentTodayWei: 0n });
  const keys = seedMerchant(db, merchantAddress);
  const relayer = new Relayer(chain, router, allowedTargets(escrow, subscriptionAddress, subscriptionVersion));
  const approval = new ApprovalService(db, chain, { enabled: approvalEnabled, delegate: APPROVER, runtimeHash: keccak256('0x60006000'), escrow, minimumAmount: 1_000_000n });
  const app = createApp({ db, chain, relayer, approval, router, escrow, subscription: subscriptionAddress });
  const requests: Array<{ url: string; body?: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://sdk.test') throw new Error('Only the in-process test API is allowed');
    requests.push({ url: url.pathname, body: init?.body as string | undefined });
    return app.request(`${url.pathname}${url.search}`, init);
  };
  return { db, chain, keys, fetcher, requests, close: () => db.close() };
}
export async function signedCall(id: string, nonce: bigint, action: 'charge' | 'refund' | 'cancel' = 'charge', amount = 2_000_000n) {
  const data = action === 'cancel'
    ? encodeFunctionData({ abi: subscriptionAbi, functionName: 'cancel', args: [id as Hex] })
    : action === 'refund'
      ? encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [id as Hex, amount, keccak256(toHex('Customer request'))] })
      : encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [id as Hex, signer.address, amount, 2592000n] });
  const intent = { signer: signer.address, merchant: signer.address, target: action === 'cancel' ? subscription : escrow, dataHash: keccak256(data), amount, feeUSDT: 10_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, router)) };
}

export function v2Mandate(planId: string, nonce = 0n) {
  return { payer: signer.address, merchant: merchantSigner.address, planId: keccak256(toHex(planId)), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now()/1000) + 86400 * 13), nonce };
}
