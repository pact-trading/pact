'use client';

import {
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

/** What the browser needs to reach the chain. Comes from the server at render time. */
export interface LiveConfig {
  localFork: boolean;
  rpcUrl: string;
  privyConfigured: boolean;
  network: {
    chainId: number;
    contracts: {
      router: Address;
      escrow: Address;
      subscription: Address;
      /** The FeeSchedule: the fee terms merchants sign. */
      fees: Address;
      usdt: Address;
      /** Invoice financing, when deployed. */
      receivables?: Address | null;
      investorRegistry?: Address | null;
    };
    dex: { swapRouter: Address; wrappedNative: Address; fee: number };
    faucetUrl: string;
    explorerUrl: string;
  } | null;
}

export const chainFor = (rpcUrl: string) =>
  defineChain({
    id: 1874,
    name: 'Whitechain Sepolia',
    nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: {
      default: { name: 'Whitechain explorer', url: 'https://explorer.testnet.whitechain.io' },
    },
    testnet: true,
  });

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type MerchantWalletKind = 'injected' | 'local';
/** Sides that sign in with a wallet. They only sign: Pact's relayer sends their transactions. */
export type WalletRole = 'merchant' | 'investor' | 'compliance';
type LocalRole = WalletRole | 'customer';
const KEYS = {
  merchantKind: 'pact.merchant.wallet',
  kind: (role: WalletRole) => (role === 'merchant' ? 'pact.merchant.wallet' : `pact.${role}.wallet`),
  key: (role: LocalRole) => `pact.local.${role}`,
};

/** Browser-held development keys. Only offered on a local fork; they never hold real funds. */
export function localAccount(role: LocalRole, create = false): PrivateKeyAccount | null {
  const name = KEYS.key(role);
  let key = window.localStorage.getItem(name) as Hex | null;
  if (!key && create) {
    key = generatePrivateKey();
    window.localStorage.setItem(name, key);
  }
  return key ? privateKeyToAccount(key) : null;
}
export const forgetLocalAccount = (role: LocalRole) => window.localStorage.removeItem(KEYS.key(role));
export const merchantWalletKind = () =>
  window.localStorage.getItem(KEYS.merchantKind) as MerchantWalletKind | null;
export const rememberMerchantWalletKind = (kind: MerchantWalletKind | null) =>
  kind
    ? window.localStorage.setItem(KEYS.merchantKind, kind)
    : window.localStorage.removeItem(KEYS.merchantKind);
export const walletKind = (role: WalletRole) =>
  window.localStorage.getItem(KEYS.kind(role)) as MerchantWalletKind | null;
export const rememberWalletKind = (role: WalletRole, kind: MerchantWalletKind | null) =>
  kind ? window.localStorage.setItem(KEYS.kind(role), kind) : window.localStorage.removeItem(KEYS.kind(role));

/** Puts the browser wallet on Whitechain Sepolia, adding the network when it is missing. */
export async function switchToWhitechain(provider: EIP1193Provider, config: LiveConfig) {
  const chainId = '0x752';
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: config.localFork ? 'Whitechain Sepolia (local fork)' : 'Whitechain Sepolia',
          nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
          rpcUrls: [config.rpcUrl],
          blockExplorerUrls: [config.network?.explorerUrl ?? 'https://explorer.testnet.whitechain.io'],
        },
      ],
    });
  }
}

/** Connects the browser wallet and returns its first account. */
export async function injectedAccount(
  config: LiveConfig,
): Promise<{ address: Address; client: WalletClient }> {
  const provider = window.ethereum;
  if (!provider) throw new Error('No browser wallet found. Install one, or use a local test wallet.');
  const [address] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  if (!address) throw new Error('The wallet did not share an account.');
  await switchToWhitechain(provider, config);
  return {
    address,
    client: createWalletClient({
      account: address,
      chain: chainFor(config.rpcUrl),
      transport: custom(provider),
    }),
  };
}

export function localClient(account: PrivateKeyAccount, config: LiveConfig): WalletClient {
  return createWalletClient({ account, chain: chainFor(config.rpcUrl), transport: http(config.rpcUrl) });
}

/** Signs a one-time login message (EIP-4361) and exchanges it for a session cookie. */
export async function walletSignIn(
  role: LocalRole,
  address: Address,
  signMessage: (message: string) => Promise<Hex>,
  email?: string,
) {
  const challengeResponse = await fetch('/api/session/wallet/nonce', { method: 'POST' });
  const challenge = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error('Sign-in is unavailable. Is the API running?');
  const message = createSiweMessage({
    address,
    chainId: challenge.chainId,
    domain: challenge.domain,
    nonce: challenge.nonce,
    uri: challenge.uri,
    version: '1',
    statement: challenge.statement,
    issuedAt: new Date(),
  });
  const signature = await signMessage(message);
  const response = await fetch('/api/session/wallet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, message, signature, email }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(signInError(body.error));
  return body as { userId: string; wallet: { address: Address }; email: string | null };
}
const signInError = (code: string) =>
  ({
    login_nonce_used: 'That sign-in request was already used. Please try again.',
    login_message_expired: 'The sign-in request expired. Please try again.',
    invalid_login_signature: 'The signature did not match the wallet.',
    invalid_login_message: 'The sign-in message was not valid for this site.',
    email_sign_in_required: 'Customers sign in with email.',
    origin_mismatch: 'Open the site at its configured address and try again.',
  })[code] ?? 'Sign-in failed. Please try again.';

type TypedField = { name: string; type: string };
/**
 * The API sends EIP-712 data with numbers as strings. Local accounts hash it themselves, so integer
 * fields are turned back into bigints; the domain type is implied by viem.
 */
export function signableTypedData(raw: Record<string, unknown>): TypedDataDefinition {
  const types = { ...(raw.types as Record<string, TypedField[]>) };
  delete types.EIP712Domain;
  const revive = (type: string, value: unknown): unknown => {
    if (type.endsWith('[]')) return (value as unknown[]).map(v => revive(type.slice(0, -2), v));
    if (/^u?int\d*$/.test(type)) return BigInt(value as string | number);
    if (types[type]) return reviveStruct(type, value as Record<string, unknown>);
    return value;
  };
  const reviveStruct = (name: string, value: Record<string, unknown>) =>
    Object.fromEntries(types[name].map(f => [f.name, revive(f.type, value[f.name])]));
  const domain = { ...(raw.domain as Record<string, unknown>) };
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  const primaryType = raw.primaryType as string;
  return {
    domain,
    types,
    primaryType,
    message: reviveStruct(primaryType, raw.message as Record<string, unknown>),
  } as unknown as TypedDataDefinition;
}
