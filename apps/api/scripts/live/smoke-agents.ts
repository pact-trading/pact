// Local fork smoke test for agents over x402: a customer creates an agent (two signatures, no gas),
// funds it with test USDT, and the agent pays a merchant's paid API with the official @x402/fetch
// client. With a 0.01 per-call cap and a 0.10 daily cap, ten calls settle and the eleventh is refused.
//   tsx scripts/live/smoke-agents.ts   (against a running `pnpm live`)
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const API = process.env.API ?? 'http://127.0.0.1:3001';
const call = async (path: string, token: string, body?: unknown) => {
  const r = await fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json();
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(json)}`);
  return json;
};
async function signIn(account: PrivateKeyAccount, email?: string) {
  const challenge = await call('/v1/auth/wallet/nonce', '', {});
  const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date() });
  return (await call('/v1/auth/wallet/verify', '', { message, signature: await account.signMessage({ message }), email })).token as string;
}
const revive = (typed: { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }) => {
  const fields = typed.types[typed.primaryType];
  const message = Object.fromEntries(fields.map(f => [f.name, f.type === 'uint256' ? BigInt(typed.message[f.name] as string) : typed.message[f.name]]));
  return { domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, types: typed.types, primaryType: typed.primaryType, message } as never;
};

const merchant = privateKeyToAccount(generatePrivateKey()), customer = privateKeyToAccount(generatePrivateKey());
const merchantToken = await signIn(merchant);
const { merchantId } = await call('/v1/auth/merchant', merchantToken, {});
const customerToken = await signIn(customer, 'agent-owner@example.test');
const intent = await call('/v1/commerce/me/agents/intent', customerToken, { name: 'Research agent', merchantIds: [merchantId], perCallCapMinor: '10000', dailyCapMinor: '100000' });
const signatures = [await customer.signTypedData(revive(intent.typedData[0])), await customer.signTypedData(revive(intent.typedData[1]))];
const agent = await call('/v1/commerce/me/agents', customerToken, { pendingId: intent.pendingId, signatures });
console.log(`agent ${agent.id} account ${agent.account} caps ${agent.perCallCapMinor}/${agent.dailyCapMinor}`);
await call('/v1/dev/faucet', customerToken, { address: agent.account, usdt: '1' });
const run = await call(`/v1/commerce/me/agents/${agent.id}/run`, customerToken, { count: 11 });
const outcome = run.calls.map((c: { status: string; reason: string | null }) => c.status === 'settled' ? 'settled' : `refused:${c.reason}`);
console.log(outcome.join(', '));
console.log(`spent today ${run.session.spentTodayMinor}, merchant endpoints:`, JSON.stringify((await call('/v1/agents/paid-endpoints', merchantToken)).data[0]));
const settled = outcome.filter((o: string) => o === 'settled').length;
if (settled !== 10 || !outcome[10].startsWith('refused')) { console.error('FAILED: expected 10 settled calls and an 11th refusal'); process.exit(1); }
const revoke = await call(`/v1/commerce/me/agents/${agent.id}/revoke-intent`, customerToken, {});
await call(`/v1/commerce/me/agents/${agent.id}/revoke`, customerToken, { pendingId: revoke.pendingId, signature: await customer.signTypedData(revive(revoke.typedData)) });
const after = await call(`/v1/commerce/me/agents/${agent.id}/run`, customerToken, { count: 1 });
console.log(`after revoke: ${after.calls[0].status}:${after.calls[0].reason}`);
if (after.calls[0].status !== 'refused') { console.error('FAILED: a revoked agent paid'); process.exit(1); }
console.log('OK');
