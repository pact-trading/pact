import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodeEventTopics, encodeAbiParameters, encodeFunctionData, getFunctionSelector, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EXACT, UPTO, USDT } from '../src/x402/constants.js';
import { exactSettlementAbi, uptoSettlementAbi } from '../src/x402/call-binding.js';
import { authorizeGatewayPayment, fundedGatewayAbi, fundedReceipt, gatewayPayment } from '../src/x402/funded-gateway.js';
import { intentTypedData } from '../src/typed-data.js';
import type { X402Receipt } from '../src/x402/write-ports.js';

const merchant = privateKeyToAccount(toHex(0x402cafen, { size: 32 }));
const outsider = privateKeyToAccount(toHex(99n, { size: 32 }));
const payer = '0x0000000000000000000000000000000000000022' as Address;
const gateway = '0x0000000000000000000000000000000000000033' as Address;
const router = '0x0000000000000000000000000000000000000044' as Address;
const gasTank = '0x0000000000000000000000000000000000000055' as Address;
const feeVault = '0x0000000000000000000000000000000000000066' as Address;
const relayer = '0x0000000000000000000000000000000000000077' as Address;
const sig = `0x${'12'.repeat(65)}` as Hex;
const permit = { permitted: { token: USDT, amount: 10_000n }, nonce: 1n, deadline: 2_000_000_000n };
const terms = { nonce: 3n, deadline: permit.deadline, feeUSDT: 540n, maxGas: 500_000 };
const authority = { signExactIntent: async (address: Address, intent: Parameters<typeof intentTypedData>[0]) => merchant.signTypedData(intentTypedData(intent, address)) };
function payment(upto = false, facilitator = gateway) {
  const proxyData = upto ? encodeFunctionData({ abi: uptoSettlementAbi, functionName: 'settle', args: [permit, 4_000n, payer, { to: merchant.address, facilitator, validAfter: 0n }, sig] })
    : encodeFunctionData({ abi: exactSettlementAbi, functionName: 'settle', args: [permit, payer, { to: merchant.address, validAfter: 0n }, sig] });
  return gatewayPayment(upto ? UPTO : EXACT, proxyData, gateway);
}
const events = parseAbi([
  'event Executed(address indexed signer,address indexed merchant,uint256 indexed nonce,address target,uint256 reimbursement,uint256 feeUSDT)',
  'event Reimbursed(address indexed merchant,address indexed relayer,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)', 'event Settled()',
]);
async function evidence() {
  const p = payment(true), request = await authorizeGatewayPayment(p, router, terms, authority);
  const log = (address: Address, topics: readonly Hex[], data: Hex) => ({ address, topics, data });
  const receipt: X402Receipt = { txHash: toHex(1n, { size: 32 }), block: 10n, status: 'success', logs: [
    log(gateway, encodeEventTopics({ abi: fundedGatewayAbi, eventName: 'PaymentSettled', args: { permitDigest: p.permitDigest, payer, merchant: merchant.address } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [UPTO, 1n, 10_000n, 4_000n])),
    log(UPTO, encodeEventTopics({ abi: events, eventName: 'Settled' }) as Hex[], '0x'),
    log(router, encodeEventTopics({ abi: events, eventName: 'Executed', args: { signer: merchant.address, merchant: merchant.address, nonce: terms.nonce } }) as Hex[], encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [gateway, 400_000n, 540n])),
    log(gasTank, encodeEventTopics({ abi: events, eventName: 'Reimbursed', args: { merchant: merchant.address, relayer } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [400_000n])),
    log(USDT, encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: payer, to: merchant.address } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [4_000n])),
    log(USDT, encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: merchant.address, to: feeVault } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [540n])),
  ] };
  return { p, request, receipt, addresses: { router, gasTank, feeVault, relayer } };
}
describe('explicit funded gateway envelope and evidence (synthetic unit fixtures)', () => {
  it('matches the actual contract artifact selectors', () => {
    const artifact = JSON.parse(readFileSync(new URL('../../../contracts/out/X402FundedGateway.sol/X402FundedGateway.json', import.meta.url), 'utf8'));
    for (const name of ['settleExact', 'settleUpto', 'sponsorshipQuote']) {
      expect(getFunctionSelector(artifact.abi.find((x: any) => x.type === 'function' && x.name === name))).toBe(getFunctionSelector(fundedGatewayAbi.find(x => x.type === 'function' && x.name === name) as any));
    }
  });
  it.each([false, true])('explicitly constructs gateway calldata and authenticates exact merchant Router intent (upto=%s)', async upto => {
    const p = payment(upto), request = await authorizeGatewayPayment(p, router, terms, authority);
    expect(request.data).toBe(p.data); expect(request.data).not.toBe(p.proxyData);
    expect(request.intent).toMatchObject({ signer: merchant.address, merchant: merchant.address, target: gateway, dataHash: keccak256(p.data), amount: upto ? 4_000n : 10_000n });
    expect(Object.isFrozen(request.intent)).toBe(true);
  });
  it('does not reinterpret an EOA-facilitator upto witness', () => { expect(() => payment(true, relayer)).toThrow('upto_requires_gateway_witness'); });
  it('rejects suffixes and unapproved proxy addresses', () => {
    const p = payment(); expect(() => gatewayPayment(EXACT, `${p.proxyData}00`, gateway)).toThrow('noncanonical');
    expect(() => gatewayPayment(router, p.proxyData, gateway)).toThrow('unsupported_proxy');
  });
  it('an application secret or unrelated key is not merchant intent authority', async () => {
    await expect(authorizeGatewayPayment(payment(), router, terms, { signExactIntent: async () => '0x1234' })).rejects.toThrow('merchant_signing_authority_required');
    await expect(authorizeGatewayPayment(payment(), router, terms, { signExactIntent: async (a, i) => outsider.signTypedData(intentTypedData(i, a)) })).rejects.toThrow('merchant_signing_authority_required');
  });
  it('rejects changed payment identity and out-of-bounds terms; ignores injected term fields', async () => {
    await expect(authorizeGatewayPayment({ ...payment(), nonce: 2n }, router, terms, authority)).rejects.toThrow('gateway_payment_conflict');
    for (const changes of [{ feeUSDT: 0n }, { maxGas: 1_000_001 }, { nonce: -1n }, { deadline: permit.deadline + 1n }]) {
      await expect(authorizeGatewayPayment(payment(), router, { ...terms, ...changes }, authority)).rejects.toThrow('invalid_merchant_intent_terms');
    }
    const req = await authorizeGatewayPayment(payment(), router, { ...terms, target: outsider.address, amount: 999n } as typeof terms, authority);
    expect(req.intent.target).toBe(gateway); expect(req.intent.amount).toBe(10_000n);
  });
  it('requires payment, fee, reimbursement, Router, gateway and official proxy evidence together', async () => {
    const { p, request, receipt, addresses } = await evidence();
    expect(fundedReceipt(receipt, p, request, addresses, 1n)).toEqual({ reimbursement: 400_000n, cap: 540_000n, feeUSDT: 540n, amount: 4_000n });
    for (let i = 0; i < receipt.logs.length; i++) expect(() => fundedReceipt({ ...receipt, logs: receipt.logs.filter((_, n) => n !== i) }, p, request, addresses, 1n)).toThrow('funded_evidence_mismatch');
    expect(() => fundedReceipt({ ...receipt, status: 'reverted' }, p, request, addresses, 1n)).toThrow();
  });
  it('refuses forged emitters, duplicate transfers, excess reimbursement and altered intent', async () => {
    const { p, request, receipt, addresses } = await evidence();
    for (let i = 0; i < receipt.logs.length; i++) expect(() => fundedReceipt({ ...receipt, logs: receipt.logs.map((log, n) => n === i ? { ...log, address: outsider.address } : log) }, p, request, addresses, 1n)).toThrow();
    expect(() => fundedReceipt({ ...receipt, logs: [...receipt.logs, receipt.logs[4]] }, p, request, addresses, 1n)).toThrow();
    expect(() => fundedReceipt({ ...receipt, logs: [...receipt.logs, { ...receipt.logs[4], data: toHex(2n, { size: 32 }) }] }, p, request, addresses, 1n)).toThrow();
    expect(() => fundedReceipt(receipt, p, { ...request, intent: { ...request.intent, maxGas: 1 } }, addresses, 1n)).toThrow();
    expect(() => fundedReceipt(receipt, p, { ...request, intent: { ...request.intent, merchant: outsider.address } }, addresses, 1n)).toThrow();
  });
});
