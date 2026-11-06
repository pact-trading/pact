// A scripted Pact user, against a running local stack (`pnpm live`): wallet sign-in, merchant setup
// (fee terms, refund permits, a product), funded test customers, and the product checkout the web
// runs. Shared by scripts/bench.mjs and scripts/chaos.mjs.
import { randomUUID } from 'node:crypto';
import { load, rpc, sleep } from './workspace.mjs';

const viem = await load('viem');
const { generatePrivateKey, privateKeyToAccount } = await load('viem/accounts');
const { createSiweMessage } = await load('viem/siwe');
export { viem };

/** Typed data as the API returns it (JSON, numbers as strings) → what viem signs. Mirrors apps/web signableTypedData. */
export function signable(raw) {
  const types = { ...raw.types };
  delete types.EIP712Domain;
  const revive = (type, value) => {
    if (type.endsWith('[]')) return value.map(v => revive(type.slice(0, -2), v));
    if (/^u?int\d*$/.test(type)) return BigInt(value);
    if (types[type]) return struct(type, value);
    return value;
  };
  const struct = (name, value) => Object.fromEntries(types[name].map(f => [f.name, revive(f.type, value[f.name])]));
  const domain = { ...raw.domain };
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: raw.primaryType, message: struct(raw.primaryType, raw.message) };
}

export class ApiError extends Error {
  constructor(path, status, body) {
    super(`${path} → ${status} ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.code = body?.error?.code ?? body?.code ?? null;
  }
}

export class Pact {
  /** @param {{ api: string, rpc: string, proxy?: string }} urls rpc is the chain itself (never the proxy). */
  constructor(urls) {
    this.urls = urls;
    this.public = viem.createPublicClient({ transport: viem.http(urls.rpc, { retryCount: 0, timeout: 20_000 }) });
  }
  async call(path, { token, body, method, headers = {}, timeoutMs = 120_000 } = {}) {
    const response = await fetch(`${this.urls.api}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!response.ok) throw new ApiError(path, response.status, json);
    return json;
  }
  async network() { return (this.net ??= await this.call('/v1/network')); }
  /** Sign-In with Ethereum, as the web does. `email` only for test customers (local fork). */
  async login(account, email) {
    const challenge = await this.call('/v1/auth/wallet/nonce', { method: 'POST' });
    const message = createSiweMessage({ address: account.address, chainId: challenge.chainId, domain: challenge.domain, nonce: challenge.nonce, uri: challenge.uri, version: '1', statement: challenge.statement, issuedAt: new Date() });
    const signature = await account.signMessage({ message });
    const session = await this.call('/v1/auth/wallet/verify', { body: { message, signature, ...(email ? { email } : {}) } });
    return session.token;
  }
  async faucet(token, address, usdt) {
    let left = Number(usdt);
    while (left > 0) {
      const chunk = Math.min(100, left);
      await this.call('/v1/dev/faucet', { token, body: { address, usdt: String(chunk) } });
      left -= chunk;
    }
  }
  async acceptedVersion(merchant) {
    const { contracts } = await this.network();
    return Number(await this.public.readContract({ address: contracts.fees, abi: viem.parseAbi(['function acceptedVersion(address) view returns (uint32)']), functionName: 'acceptedVersion', args: [merchant] }));
  }
  /** A merchant wallet with Pact's fee terms (and, unless skipped, both refund permits) signed, and one active product. */
  async merchant({ key = generatePrivateKey(), priceMinor = '2000000', permits = true, name } = {}) {
    const account = privateKeyToAccount(key);
    const token = await this.login(account);
    const { merchantId } = await this.call('/v1/auth/merchant', { token, body: {} });
    const offer = await this.call('/v1/fees/terms', { token });
    if (await this.acceptedVersion(account.address) !== Number(offer.version)) {
      const signature = await account.signTypedData(signable(offer.typedData));
      await this.call('/v1/fees/terms/accept', { token, body: { version: offer.version, deadline: offer.deadline, signature } });
      await until(async () => (await this.acceptedVersion(account.address)) === Number(offer.version), 90, 'fee terms on chain');
    }
    if (permits) for (const spender of ['escrow', 'router']) {
      const readiness = await this.call(`/v1/fees/permits/${spender}`, { token });
      if (readiness.status === 'needs_approval') {
        const signature = await account.signTypedData(signable(readiness.typedData));
        await this.call(`/v1/fees/permits/${spender}`, { token, body: { nonce: readiness.permitNonce, deadline: readiness.deadline, signature } });
      }
      await until(async () => (await this.call(`/v1/fees/permits/${spender}`, { token })).status === 'ready', 90, `${spender} permit`);
    }
    const product = await this.call('/v1/commerce/products', { token, body: { name: name ?? `Bench item ${merchantId.slice(-6)}`, description: 'Benchmark product', status: 'active', prices: [{ currency: 'USDT', amountMinor: priceMinor }] } });
    return { key, account, address: account.address.toLowerCase(), token, merchantId, productId: product.id, priceMinor };
  }
  /** A test customer (local email sign-in) funded with `usdt` test USDT from the local faucet. */
  async customer({ key = generatePrivateKey(), usdt = 50 } = {}) {
    const account = privateKeyToAccount(key);
    const token = await this.login(account, `bench-${account.address.slice(2, 10).toLowerCase()}@pact.local`);
    if (usdt > 0) await this.faucet(token, account.address, usdt);
    return { key, account, address: account.address.toLowerCase(), token };
  }
  async webhook(merchant, url) {
    return this.call('/v1/webhooks/config', { token: merchant.token, body: { url } });
  }
  /**
   * One product checkout, the way the web runs it: readiness → (permit if needed) → intent → sign →
   * submit → poll until paid or failed. Works for any typed data the API asks the payer to sign.
   * `hooks.beforeSubmit(record)` / `hooks.afterSubmit(record)` let chaos scenarios act at those points.
   * `client: 'web'` (default) polls like the web app: readiness every second while a permit confirms,
   * then the session and its readiness every second. `client: 'fast'` polls only the session, every 250 ms.
   */
  async checkout(customer, productId, { timeoutMs = 180_000, hooks = {}, client = 'web', submit = true } = {}) {
    const poll = client === 'fast' ? 250 : 1000;
    const record = { productId, payer: customer.address, outcome: 'error', reason: null, sessionId: null, paymentId: null, approvalTx: null, chargeTx: null, ms: {} };
    const t0 = performance.now();
    const mark = name => { record.ms[name] = Math.round(performance.now() - t0); };
    try {
      const created = await this.call('/v1/commerce/checkout-sessions', { token: customer.token, body: { productId, rail: 'whitechain' }, headers: { 'idempotency-key': randomUUID() } });
      record.sessionId = created.session.id;
      record.paymentId = created.order.paymentId;
      const base = `/v1/commerce/checkout-sessions/${encodeURIComponent(record.sessionId)}`;
      mark('created');
      let readiness = await this.call(`${base}/readiness`, { token: customer.token });
      if (readiness.status === 'needs_funding') throw Object.assign(new Error('needs_funding'), { code: 'needs_funding' });
      if (readiness.status === 'needs_approval') {
        const signature = await customer.account.signTypedData(signable(readiness.typedData));
        readiness = await this.call(`${base}/approval`, { token: customer.token, body: { deadline: readiness.deadline, signature, ...(readiness.permitNonce !== null ? { nonce: readiness.permitNonce } : {}) } });
        mark('approvalSubmitted');
      }
      const readyBy = Date.now() + timeoutMs;
      while (readiness.status !== 'ready') {
        if (readiness.status !== 'pending' && readiness.status !== 'needs_approval') throw Object.assign(new Error(readiness.reason ?? readiness.status), { code: readiness.reason ?? readiness.status });
        if (Date.now() > readyBy) throw Object.assign(new Error('approval_timeout'), { code: 'approval_timeout' });
        await sleep(poll);
        readiness = await this.call(`${base}/readiness`, { token: customer.token });
      }
      record.approvalTx = readiness.txHash ?? null;
      if (record.ms.approvalSubmitted !== undefined) mark('approvalReady');
      const request = await this.call(`${base}/intent`, { token: customer.token });
      const signature = await customer.account.signTypedData(signable(request.typedData));
      mark('signed');
      if (!submit) { record.outcome = 'prepared'; record.request = { base, body: { data: request.data, intent: request.intent, signature } }; return record; }
      await hooks.beforeSubmit?.(record);
      const submitting = this.call(`${base}/intent`, { token: customer.token, body: { data: request.data, intent: request.intent, signature } });
      if (hooks.whileSubmitting) await hooks.whileSubmitting(record, submitting);
      const submitted = await submitting;
      record.chargeTx = submitted.txHash ?? null;
      mark('submitted');
      await hooks.afterSubmit?.(record);
      return await this.waitPaid(customer, record, { timeoutMs, client, t0 });
    } catch (error) {
      record.outcome = 'error';
      record.reason = error.code ?? error.message;
      record.ms.total = Math.round(performance.now() - t0);
      return record;
    }
  }
  /** Polls the checkout session until it is paid or failed (as the web does: the session and its readiness, each second). */
  async waitPaid(customer, record, { timeoutMs = 180_000, client = 'web', t0 = performance.now() } = {}) {
    const base = `/v1/commerce/checkout-sessions/${encodeURIComponent(record.sessionId)}`;
    const poll = client === 'fast' ? 250 : 1000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let view;
      try {
        view = await this.call(base, { token: customer.token });
        if (client !== 'fast') await this.call(`${base}/readiness`, { token: customer.token }).catch(() => null);
      } catch (error) { view = null; record.lastError = error.message; }
      if (view) {
        record.chargeTx ??= view.payment?.txHash ?? null;
        if (view.session.status === 'complete' || view.order.status === 'paid') { record.outcome = 'paid'; break; }
        if (view.order.status === 'failed' || view.order.status === 'expired') { record.outcome = view.order.status; record.reason = view.payment?.financialStatus ?? view.order.status; break; }
      }
      if (Date.now() > deadline) { record.outcome = 'timeout'; record.reason = view ? `order ${view.order.status}` : record.lastError; break; }
      await sleep(poll);
    }
    record.ms.paid = Math.round(performance.now() - t0);
    record.ms.total = record.ms.paid;
    return record;
  }
  async receipt(hash) {
    if (!hash) return null;
    try { return await rpc(this.urls.rpc, 'eth_getTransactionReceipt', [hash]); } catch { return null; }
  }
  /** Chaos proxy control, when one is configured. */
  async chaos(path = '', body) {
    if (!this.urls.proxy) return null;
    const response = await fetch(`${this.urls.proxy}/__chaos${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return response.json();
  }
}

export async function until(check, seconds, what) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try { if (await check()) return; } catch {}
    if (Date.now() > deadline) throw new Error(`${what}: not reached within ${seconds}s`);
    await sleep(500);
  }
}
/** Runs `work(item)` over `items` with at most `limit` in flight. */
export async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i], i); }
  }));
  return results;
}
