#!/usr/bin/env python3
"""Keyless, pinned-fork deployment rehearsal. Never broadcasts or edits live config."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RPC = os.environ.get('WHITECHAIN_RPC', 'https://rpc.testnet.whitechain.io')
DEPLOYER = os.environ.get('DEPLOYER_ADDRESS', '0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a')
FEE_VAULT = os.environ.get('FEE_VAULT', DEPLOYER)
KEEPER = os.environ.get('KEEPER', '0x59Ca3DA1771d19d27724a713F3363eFbF0a714A3')
for value in (DEPLOYER, FEE_VAULT, KEEPER):
    if not re.fullmatch(r'0x[0-9a-fA-F]{40}', value) or int(value, 16) == 0:
        raise SystemExit('Expected nonzero public role addresses')


def rpc(method, params):
    request = urllib.request.Request(RPC, data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params,
    }).encode(), headers={'content-type': 'application/json', 'accept': 'application/json',
                         'user-agent': 'GOL-Deployment-Preview/1.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if 'error' in result:
        raise RuntimeError(f'RPC {method} failed: {result["error"]}')
    return result['result']


if int(rpc('eth_chainId', []), 16) != 1874:
    raise SystemExit('Wrong chain: expected Whitechain Sepolia (1874)')
block = int(os.environ.get('FORK_BLOCK', str(int(rpc('eth_blockNumber', []), 16))))
nonce = int(rpc('eth_getTransactionCount', [DEPLOYER, hex(block)]), 16)
pending_nonce = int(rpc('eth_getTransactionCount', [DEPLOYER, 'pending']), 16)
if nonce != pending_nonce:
    raise SystemExit('Deployer nonce changed or has pending transactions; choose a fresh fork block')

output = Path(tempfile.mkdtemp(prefix='gol-deploy-preview-'))
project = output / 'contracts'
project.mkdir()
shutil.copytree(ROOT / 'contracts/src', project / 'src')
shutil.copy2(ROOT / 'contracts/foundry.toml', project / 'foundry.toml')
(project / 'lib').symlink_to(ROOT / 'contracts/lib', target_is_directory=True)
(project / 'script').mkdir()
original = (ROOT / 'contracts/script/Deploy.s.sol').read_text()
preview = original
for old, new in [
    ('uint256 deployerKey = vm.envUint("PRIVATE_KEY");', 'address deployer = vm.envAddress("DEPLOYER_ADDRESS");'),
    ('address deployer = vm.addr(deployerKey);', ''),
    ('vm.startBroadcast(deployerKey);', 'vm.startBroadcast(deployer);'),
]:
    if preview.count(old) != 1:
        raise SystemExit('Deploy script changed; review the preview transformation before running')
    preview = preview.replace(old, new)
(project / 'script/Deploy.s.sol').write_text(preview)

env = {k: v for k, v in os.environ.items() if 'PRIVATE_KEY' not in k and 'MNEMONIC' not in k and not k.startswith('FOUNDRY_')}
env.update(DEPLOYER_ADDRESS=DEPLOYER, FEE_VAULT=FEE_VAULT, KEEPER=KEEPER)
command = ['forge', 'script', 'script/Deploy.s.sol:Deploy', '--rpc-url', RPC,
           '--fork-block-number', str(block), '--legacy']
print(f'Keyless deployment rehearsal at block {block}; output: {output}', flush=True)
with (output / 'simulation.log').open('w') as log:
    result = subprocess.run(command, cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=300)
if result.returncode:
    raise SystemExit(f'Simulation failed; inspect {output / "simulation.log"}')

raw = json.loads((project / 'broadcast/Deploy.s.sol/1874/dry-run/run-latest.json').read_text())
transactions = raw['transactions']
if len(transactions) != 15 or len([t for t in transactions if t['transactionType'] == 'CREATE']) != 4:
    raise SystemExit('Unexpected deployment transaction plan; review before approval')
summary = {
    'status': 'simulated_only_not_deployed', 'chainId': 1874, 'forkBlock': block,
    'deployer': DEPLOYER, 'feeVault': FEE_VAULT, 'keeper': KEEPER,
    'deployerNonce': nonce, 'pendingNonce': pending_nonce,
    'deployerBalanceWei': str(int(rpc('eth_getBalance', [DEPLOYER, hex(block)]), 16)),
    'deployScriptSha256': hashlib.sha256(original.encode()).hexdigest(),
    'sourceSha256': {str(p.relative_to(ROOT / 'contracts')): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted((ROOT / 'contracts/src').rglob('*.sol'))},
    'transactionCount': len(transactions),
    'predictedContracts': {t['contractName']: t['contractAddress'] for t in transactions if t['transactionType'] == 'CREATE'},
    'transactions': [{k: t.get(k) for k in ('transactionType', 'contractName', 'contractAddress', 'function', 'arguments')}
                     | {'nonce': int(t['transaction']['nonce'], 16), 'gas': int(t['transaction']['gas'], 16)}
                     for t in transactions],
    'note': 'Predictions depend on the deployer nonce. Do not activate API configuration until receipts and bindings are verified.',
}
summary['estimatedGasLimitSum'] = sum(t['gas'] for t in summary['transactions'])
summary['gasPriceWei'] = str(int(rpc('eth_gasPrice', []), 16))
summary['estimatedFeeWei'] = str(summary['estimatedGasLimitSum'] * int(summary['gasPriceWei']))
for address in summary['predictedContracts'].values():
    if rpc('eth_getCode', [address, hex(block)]) != '0x':
        raise SystemExit('A predicted address already has code; review nonce and fork block')
(output / 'manifest.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'manifest': str(output / 'manifest.json'), 'transactions': len(transactions),
                  'estimatedFeeWei': summary['estimatedFeeWei'], 'broadcast': False}, indent=2))
