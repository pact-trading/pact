// Testnet support for the live checks (PACT_LIVE_URL=https://pay.pactagent.app).
// - The merchant is an injected browser wallet whose key stays in this Node process: the page calls
//   window.ethereum, Playwright forwards each request here, and viem signs and sends.
// - The customer is the Privy app's test account, read from Privy with the app credentials in apps/api/.env.local.
// - Funds come from the deployer in .env.testnet, topped up only to what a flow needs.
// The merchant key is generated once and kept in .runtime/testnet/live-check.json (gitignored), so every
// flow reuses one merchant, with its fee terms and permits signed, instead of setting up a new one each time.
// The merchant wallet only signs: Pact's relayer sends its transactions, so it never needs WBT.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  http,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RPC = process.env.PACT_LIVE_RPC ?? 'https://rpc.testnet.whitechain.io';
const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const WWBT = '0x4200000000000000000000000000000000000006';
const SWAP_ROUTER = '0xe208cC685cD95D56E8ec6DEC9816476567fc6962';
const POOL = '0x5645101Ca8d2F7BaBC27b10359555767a1BdF999';
const chain = defineChain({
  id: 1874,
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const router = parseAbi([
  'struct P { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(P params) payable returns (uint256)',
]);
const pool = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);

function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const hexKey = v => (v?.startsWith('0x') ? v : `0x${v}`);
const keys = readEnv(process.env.PACT_LIVE_KEYS ?? resolve(root, '.env.testnet'));
const privy = readEnv(resolve(root, 'apps/api/.env.local'));
if (!keys.DEPLOYER_PRIVATE_KEY)
  throw new Error('Testnet checks need DEPLOYER_PRIVATE_KEY in .env.testnet (it funds the test wallets)');
if (!privy.PRIVY_APP_ID || !privy.PRIVY_APP_SECRET)
  throw new Error('Testnet checks need PRIVY_APP_ID and PRIVY_APP_SECRET in apps/api/.env.local');
const deployer = privateKeyToAccount(hexKey(keys.DEPLOYER_PRIVATE_KEY));
const funder = createWalletClient({ chain, account: deployer, transport: http(RPC, { timeout: 30_000 }) });

const statePath = resolve(root, '.runtime/testnet/live-check.json');
function merchantKey() {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8')).merchantKey;
  mkdirSync(dirname(statePath), { recursive: true });
  const merchantKey = generatePrivateKey();
  writeFileSync(statePath, `${JSON.stringify({ merchantKey }, null, 2)}\n`, { mode: 0o600 });
  return merchantKey;
}
export const merchant = privateKeyToAccount(merchantKey());
const merchantWallet = createWalletClient({
  chain,
  account: merchant,
  transport: http(RPC, { timeout: 30_000 }),
});
/** The app's Privy test account (dashboard → test accounts): a fixed email and one-time code. */
async function privyTestAccount() {
  const response = await fetch(`https://api.privy.io/v1/apps/${privy.PRIVY_APP_ID}/test_credentials`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${privy.PRIVY_APP_ID}:${privy.PRIVY_APP_SECRET}`).toString('base64')}`,
      'privy-app-id': privy.PRIVY_APP_ID,
    },
  });
  if (!response.ok) throw new Error(`Privy test credentials: ${response.status}`);
  const body = await response.json();
  const [account] = body.test_accounts ?? body.data ?? [];
  if (!account?.email || !/^\d{6}$/.test(account.otp_code ?? ''))
    throw new Error('Enable a test account in the Privy dashboard');
  return { email: account.email, otp: String(account.otp_code) };
}
const testAccount = await privyTestAccount();
export const customerEmail = testAccount.email;
const customerOtp = testAccount.otp;

const wait = async hash => {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success') throw new Error(`transaction failed: ${hash}`);
  return r;
};

/** `address` holds at least `usdt` USDT: the deployer swaps WBT on the testnet DEX, paid to it. */
export async function topUpUsdt(address, usdt) {
  const want = BigInt(Math.round(Number(usdt) * 1e6));
  const have = await pub.readContract({
    address: USDT,
    abi: erc20,
    functionName: 'balanceOf',
    args: [address],
  });
  if (have >= want) return;
  const [sqrtPriceX96] = await pub.readContract({ address: POOL, abi: pool, functionName: 'slot0' });
  // token0 is WWBT: price = USDT units per WBT wei. 15% headroom covers the fee and slippage.
  const usdtPerWei = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const missing = want - have;
  const amountIn = BigInt(Math.ceil((Number(missing) / usdtPerWei) * 1.15));
  await wait(
    await funder.writeContract({
      address: SWAP_ROUTER,
      abi: router,
      functionName: 'exactInputSingle',
      value: amountIn,
      type: 'legacy',
      args: [
        {
          tokenIn: WWBT,
          tokenOut: USDT,
          fee: 3000,
          recipient: address,
          amountIn,
          amountOutMinimum: missing,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  );
  console.log(
    `  (deployer swapped ${formatEther(amountIn)} WBT → ≥${formatUnits(missing, 6)} USDT for ${address})`,
  );
}

/** Answers the page's window.ethereum requests as the merchant wallet. */
async function walletRequest(method, params = []) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts':
      return [merchant.address];
    case 'eth_chainId':
      return '0x752';
    case 'net_version':
      return '1874';
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain':
      return null;
    case 'personal_sign':
      return merchant.signMessage({ message: { raw: params[0] } });
    case 'eth_signTypedData_v4': {
      const { domain, types, primaryType, message } = JSON.parse(params[1]);
      delete types.EIP712Domain;
      return merchant.signTypedData({ domain, types, primaryType, message });
    }
    case 'eth_sendTransaction': {
      const tx = params[0];
      return merchantWallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ? BigInt(tx.value) : 0n,
        gas: tx.gas ? BigInt(tx.gas) : undefined,
        type: 'legacy',
      });
    }
    default:
      return pub.request({ method, params });
  }
}

/** Installs the merchant wallet as window.ethereum in every page of the context. */
export async function installWallet(context) {
  await context.exposeBinding('__pactWallet', async (_source, method, params) => {
    try {
      return { ok: true, value: await walletRequest(method, params) };
    } catch (e) {
      return { ok: false, code: e?.code ?? 4001, message: String(e?.shortMessage ?? e?.message ?? e) };
    }
  });
  await context.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      isMetaMask: true,
      async request({ method, params }) {
        const r = await window.__pactWallet(method, params ?? []);
        if (r.ok) return r.value;
        throw Object.assign(new Error(r.message), { code: r.code });
      },
      on(event, fn) {
        (listeners[event] ??= []).push(fn);
      },
      removeListener(event, fn) {
        listeners[event] = (listeners[event] ?? []).filter(f => f !== fn);
      },
    };
  });
}

/** Signs in the Privy test customer through the email login. */
export async function privySignIn(page, base) {
  await page.goto(`${base}/login`);
  const already = page.getByRole('button', { name: /See my purchases|Continue to payment/ });
  if (await already.count()) return already.first().click();
  await page.getByRole('button', { name: 'Continue with email' }).click();
  const email = page.locator('input[type="email"], input#email-input').first();
  await email.waitFor({ timeout: 30000 });
  await email.fill(customerEmail);
  await page
    .getByRole('button', { name: /^Submit$|^Continue$/ })
    .first()
    .click();
  const code = page.locator('input[name^="code-"], input[autocomplete="one-time-code"]');
  await code.first().waitFor({ timeout: 30000 });
  // Privy shows one box per digit and submits once the last one is filled.
  if ((await code.count()) > 1)
    for (const [i, digit] of [...customerOtp].entries()) await code.nth(i).fill(digit);
  else await code.first().fill(customerOtp);
}
