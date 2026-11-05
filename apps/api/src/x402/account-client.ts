import { hashTypedData, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { EXACT, PERMIT2, UPTO, USDT } from './constants.js';
export const agentAccountAbi = parseAbi([
  'function sessionDigest(bytes32 digest) view returns (bytes32)',
  'function reserve((address spender,uint256 amount,uint256 nonce,uint256 deadline,address to,address facilitator,uint256 validAfter) payment,bytes signature) returns (bytes32)',
  'function bootstrap(uint256 amount,uint256 deadline,bytes signature)',
]);
export interface ReservedPayment {
  spender: Address; amount: bigint; nonce: bigint; deadline: bigint;
  to: Address; facilitator: Address; validAfter: bigint;
}
export interface AccountReservationAdapter {
  /** MUST use root's shared durable journal, enforce sponsorship budgets, and wait for
   * successful confirmation. Deduplicate by account + permitDigest; never return on timeout.
   * SqliteAccountReservationAdapter supplies this boundary through the shared AccountWriter. */
  reserve(account: Address, payment: ReservedPayment, signature: Hex): Promise<void>;
}
/** Standard official ClientEvmSigner interface. @x402/fetch and scheme code remain unchanged.
 * The account-specific signer reserves the signed ceiling onchain before returning its signature.
 */
export function createX402AccountSigner(account: Address, pub: PublicClient,
  session: { sign(args: { hash: Hex }): Promise<Hex> }, adapter: AccountReservationAdapter) {
  return {
    address: account,
    async signTypedData(typed: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex> {
      if (typed.domain.name !== 'Permit2' || Number(typed.domain.chainId) !== 1874 || String(typed.domain.verifyingContract).toLowerCase() !== PERMIT2.toLowerCase() || typed.primaryType !== 'PermitWitnessTransferFrom') throw new Error('unsupported_account_signature');
      const m = typed.message as { permitted: { token: Address; amount: bigint }; spender: Address; nonce: bigint; deadline: bigint; witness: { to: Address; facilitator?: Address; validAfter: bigint } };
      if (m.permitted.token.toLowerCase() !== USDT.toLowerCase() || ![EXACT.toLowerCase(), UPTO.toLowerCase()].includes(m.spender.toLowerCase())) throw new Error('unsupported_account_asset_or_spender');
      const digest = hashTypedData(typed as never);
      const hash = await pub.readContract({ address: account, abi: agentAccountAbi, functionName: 'sessionDigest', args: [digest] });
      const signature = await session.sign({ hash });
      await adapter.reserve(account, { spender: m.spender, amount: m.permitted.amount, nonce: m.nonce, deadline: m.deadline, to: m.witness.to, facilitator: m.witness.facilitator ?? '0x0000000000000000000000000000000000000000', validAfter: m.witness.validAfter }, signature);
      return signature;
    },
  };
}
