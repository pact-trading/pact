'use client';

import { createContext, useContext } from 'react';
import type { Address, Hex, WalletClient } from 'viem';
import type { LiveConfig, MerchantWalletKind } from '@/lib/live-wallet';
import type { SignRequest } from '@/server/data/types';

export interface PactAuth {
  mode: 'mock' | 'privy' | 'live' | 'none';
  /** False when no sign-in provider is set up; actions that need a signature are unavailable. */
  configured: boolean;
  ready: boolean;
  identity: { email: string | null; name: string | null } | null;
  error: string;
  login(): void;
  logout(): Promise<void>;
  /** Collects the user's signature for a prepared action. Rejects when the user cancels. */
  sign(request: SignRequest): Promise<string>;
  /** Live mode only: the merchant wallet and the customer account, side by side. */
  live?: LiveAuth;
}

export interface CustomerApproval {
  signature: Hex;
  authorization?: { address: Hex; chainId: number; nonce: number; r: Hex; s: Hex; yParity?: number };
}
export interface LiveAuth {
  config: LiveConfig;
  merchant: { address: Address; kind: MerchantWalletKind | null } | null;
  customer: { address: Address; email: string | null; kind: 'privy' | 'local' } | null;
  /** Invoice financing: an investor's wallet and a compliance officer's wallet. */
  investor: { address: Address; kind: MerchantWalletKind | null } | null;
  compliance: { address: Address; kind: MerchantWalletKind | null } | null;
  busy: boolean;
  connectMerchant(kind: MerchantWalletKind): Promise<void>;
  connectWallet(role: 'investor' | 'compliance', kind: MerchantWalletKind): Promise<void>;
  signInCustomer(kind: 'privy' | 'local', email?: string): void | Promise<void>;
  signOut(role: 'merchant' | 'customer' | 'investor' | 'compliance'): Promise<void>;
  /** A client for the merchant's own transactions: tank deposit, daily cap, approvals, swaps. */
  merchantWallet(): Promise<WalletClient>;
  /** The customer's one-time USDT approval: a raw digest and, the first time, an EIP-7702 authorization. */
  approveAsCustomer(message: Hex, delegate: Hex | null, nonce: number | null): Promise<CustomerApproval>;
}

export const unconfiguredAuth: PactAuth = {
  mode: 'none',
  configured: false,
  ready: true,
  identity: null,
  error: '',
  login() {},
  async logout() {
    await fetch('/api/session', { method: 'DELETE' });
    window.location.replace('/login');
  },
  async sign() {
    throw new Error('Sign-in is not configured.');
  },
};

export const AuthContext = createContext<PactAuth>(unconfiguredAuth);
export const usePactAuth = () => useContext(AuthContext);

export class SignatureCancelled extends Error {
  constructor() {
    super('Confirmation was cancelled.');
  }
}
