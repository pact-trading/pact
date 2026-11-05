import { formatUnits, parseUnits } from 'viem';
import { USDT_DECIMALS } from './chain.js';

/** Converts a nonnegative decimal USDT amount to exact six-decimal base units. */
export function parseUsdt(amount: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount)) {
    throw new RangeError('USDT amount must be a nonnegative decimal with at most 6 places');
  }
  return parseUnits(amount, USDT_DECIMALS);
}

export function formatUsdt(units: bigint): string {
  return formatUnits(units, USDT_DECIMALS);
}
