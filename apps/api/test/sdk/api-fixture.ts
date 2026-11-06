// Entirely in-process: synthetic signer, in-memory SQLite, FakeChain, no RPC/listener.
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { openDb, seedMerchant } from '../../src/db.js';
import { FakeChain, escrowAbi } from '../../src/chain.js';
import { createApp } from '../../src/app.js';
import { Relayer, allowedTargets } from '../../src/relayer.js';
import { Indexer } from '../../src/indexer.js';
import { ApprovalService, USDT } from '../../src/approval.js';
import { intentTypedData } from '@pactagent/core';
export { Indexer, USDT };
export const signer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
export const merchantSigner = privateKeyToAccount(`0x${'3'.repeat(64)}`);
export const router: Address = '0x0000000000000000000000000000000000000001';
export const escrow: Address = '0x0000000000000000000000000000000000000002';
export const subscription: Address = '0x0000000000000000000000000000000000000003';
export function apiFixture(autoSettle = true, approvalEnabled = false, merchantAddress: Address = signer.address) {
  const db = openDb();
  const chain = new FakeChain(autoSettle);
  // The SDK suites exercise the USDT permit + Router intent path; one-signature checkout has its own tests.
  chain.collectorEnabled = false;
  // The merchant signed Pact's fee terms; with approvals off, its wallet holds USDT and allows every spender.
  chain.accepted.set(merchantAddress.toLowerCase(), 1);
  if (!approvalEnabled) chain.approval.state = { balance: 100_000_000n, allowance: 2n ** 256n - 1n, nonce: 0n };
  const keys = seedMerchant(db, merchantAddress);
  const relayer = new Relayer(chain, router, allowedTargets({ escrow, subscription }));
  const approval = new ApprovalService(db, chain, { enabled: approvalEnabled, escrow, minimumAmount: 1_000_000n });
  const app = createApp({ db, chain, relayer, approval, router, escrow, subscription });
  const requests: Array<{ url: string; body?: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://sdk.test') throw new Error('Only the in-process test API is allowed');
    requests.push({ url: url.pathname, body: init?.body as string | undefined });
    return app.request(`${url.pathname}${url.search}`, init);
  };
  return { db, chain, keys, fetcher, requests, close: () => db.close() };
}
export async function signedCall(id: string, nonce: bigint, action: 'charge' | 'chargeInvoice' | 'refund' = 'charge', amount = 2_000_000n) {
  const data = action === 'refund'
    ? encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [id as Hex, amount, keccak256(toHex('Customer request'))] })
    : encodeFunctionData({ abi: escrowAbi, functionName: action, args: [id as Hex, signer.address, amount, 2592000n] });
  const intent = { signer: signer.address, merchant: signer.address, target: escrow, dataHash: keccak256(data), amount, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, router)) };
}

export function v2Mandate(planId: string, nonce = 0n) {
  return { payer: signer.address, merchant: merchantSigner.address, planId: keccak256(toHex(planId)), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now()/1000) + 86400 * 13), nonce };
}
