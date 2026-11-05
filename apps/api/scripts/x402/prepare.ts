// Read-only chain inspection plus unsigned deployment artifacts. No wallet or secrets.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, concat, encodeAbiParameters, getCreate2Address, keccak256, parseAbi, toHex, type Hex } from 'viem';
import { CREATE2, EXACT, NETWORK, PERMIT2, UPTO, UPTO_SALT, USDT } from '../../src/x402/constants.js';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const artifact = JSON.parse(readFileSync(`${root}/contracts/x402-reference/out/x402UptoPermit2Proxy.sol/x402UptoPermit2Proxy.json`, 'utf8'));
const initCode = concat([artifact.bytecode.object as Hex, encodeAbiParameters([{ type: 'address' }], [PERMIT2])]);
if (getCreate2Address({ from: CREATE2, salt: UPTO_SALT, bytecode: initCode }) !== UPTO) throw new Error('noncanonical_build');
const rpc = 'https://rpc.testnet.whitechain.io';
const pub = createPublicClient({ transport: http(rpc) });
if (await pub.getChainId() !== 1874) throw new Error('wrong_chain');
const blockNumber = await pub.getBlockNumber();
const runtimes: Record<string, unknown> = {};
for (const address of [USDT, PERMIT2, EXACT, UPTO, CREATE2]) {
  const code = await pub.getCode({ address, blockNumber });
  runtimes[address] = { bytes: code ? (code.length - 2) / 2 : 0, hash: code && code !== '0x' ? keccak256(code) : null };
}
const decimals = await pub.readContract({ address: USDT, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals', blockNumber });
const exactPermit2 = await pub.readContract({ address: EXACT, abi: parseAbi(['function PERMIT2() view returns (address)']), functionName: 'PERMIT2', blockNumber });
// Compare Whitechain Permit2 with its canonical Ethereum deployment. The only permitted
// differences are the two EIP712 constructor immutables documented in pinned Uniswap source.
const ethereum = createPublicClient({ transport: http('https://ethereum-rpc.publicnode.com') });
const ethereumBlock = await ethereum.getBlockNumber();
const ethereumCode = (await ethereum.getCode({ address: PERMIT2, blockNumber: ethereumBlock }))!;
const whitechainCode = (await pub.getCode({ address: PERMIT2, blockNumber }))!;
const domain = (chainId: bigint) => keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
  [keccak256(toHex('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), keccak256(toHex('Permit2')), chainId, PERMIT2]));
const normalize = (code: Hex, chainId: bigint) => {
  if (code.length !== 18306 || code.slice(2 + 6945 * 2, 2 + 6977 * 2) !== toHex(chainId, { size: 32 }).slice(2)
    || code.slice(2 + 6983 * 2, 2 + 7015 * 2) !== domain(chainId).slice(2)) throw new Error('unexpected_permit2_immutables');
  return code.slice(0, 2 + 6945 * 2) + '0'.repeat(64) + code.slice(2 + 6977 * 2, 2 + 6983 * 2) + '0'.repeat(64) + code.slice(2 + 7015 * 2);
};
if (normalize(whitechainCode, 1874n) !== normalize(ethereumCode, 1n)) throw new Error('noncanonical_permit2_runtime');
let uptoRuntime = artifact.deployedBytecode.object as string;
for (const entries of Object.values(artifact.deployedBytecode.immutableReferences) as { start: number; length: number }[][]) {
  for (const { start, length } of entries) uptoRuntime = uptoRuntime.slice(0, 2 + start * 2) + PERMIT2.slice(2).toLowerCase().padStart(length * 2, '0') + uptoRuntime.slice(2 + (start + length) * 2);
}
const expectedUptoRuntimeHash = keccak256(uptoRuntime as Hex);
const result = { network: NETWORK, rpc, observedAt: new Date().toISOString(), blockNumber: String(blockNumber), permit2CanonicalComparison: { ethereumBlock: String(ethereumBlock), ethereumRuntimeHash: keccak256(ethereumCode), equalExceptValidatedChainIdAndDomainImmutables: true, source: 'https://github.com/Uniswap/permit2/blob/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219/src/EIP712.sol' }, decimals, exactPermit2, runtimes,
  uptoDeployment: { to: CREATE2, value: '0', data: concat([UPTO_SALT, initCode]), expectedAddress: UPTO, initCodeHash: keccak256(initCode), expectedRuntimeHash: expectedUptoRuntimeHash, status: 'prepared_only_not_broadcast' } };
writeFileSync(`${root}/docs/x402/whitechain-readonly.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, uptoDeployment: { ...result.uptoDeployment, data: '(see artifact file)' } }, null, 2));
