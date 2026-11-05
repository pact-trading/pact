// Offline cross-layer check: feed the actual API gas allowance to the Router's
// Foundry tests. No RPC, wallets or on-chain transactions are used.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, keccak256, type Hex } from 'viem';
import { escrowAbi, routerAbi } from '../src/chain.js';
import { transactionGas } from '../src/relayer.js';
import type { IntentRequest } from '../src/types.js';

const address = '0x0000000000000000000000000000000000000001';
const id = `0x${'a'.repeat(64)}` as Hex;
const env = { ...process.env };
for (const [key, maxGas, refund] of [
  ['API_CHARGE_EXECUTION_GAS', 400_000, false],
  ['API_LIMIT_EXECUTION_GAS', 1_000_000, false],
  ['API_REFUND_EXECUTION_GAS', 400_000, true],
] as const) {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: refund ? 'refund' : 'charge', args: refund ? [id, 1_000_000n, id] : [id, address, 1_000_000n, 86400n] });
  const request: IntentRequest = {
    intent: { signer: address, merchant: address, target: address, dataHash: keccak256(data), amount: 1_000_000n, feeUSDT: 10_000n, nonce: 1n, deadline: 867600n, maxGas },
    data, signature: `0x${'11'.repeat(65)}`,
  };
  const encoded = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [request.intent, data, request.signature] });
  let intrinsic = 21_000n;
  for (let i = 2; i < encoded.length; i += 2) intrinsic += encoded.slice(i, i + 2) === '00' ? 4n : 16n;
  env[key] = (transactionGas(request) - intrinsic).toString();
  console.log(`${key}=${env[key]}`);
}
const result = spawnSync('forge', ['test', '--match-test', 'testApiGasBudget', '-vv'], {
  cwd: fileURLToPath(new URL('../../../contracts/', import.meta.url)), env, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
