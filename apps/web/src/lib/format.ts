import type { Money } from '@pactagent/core/commerce-types';

const USDT_DECIMALS = 6;

/** Parses a decimal USDT string ("12.5") into 6-decimal base units. */
export function toMinor(decimal: string, decimals = USDT_DECIMALS): bigint {
  const value = decimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid amount: ${decimal}`);
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  return negative ? -minor : minor;
}

/** Converts base units back to a decimal string with trailing zeros trimmed to 2 places. */
export function fromMinor(minor: bigint | string, decimals = USDT_DECIMALS): string {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${(abs / scale).toString()}.${fraction}`;
}

/**
 * Customer-facing dollar amount from USDT base units: "$1,000.00".
 * Rounds to cents; amounts under a cent keep up to four places ("$0.0005").
 */
export function usd(minor: bigint | string, options: { signed?: boolean } = {}): string {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const sign = negative ? '-' : options.signed && value > 0n ? '+' : '';
  if (abs > 0n && abs < 10_000n) {
    const fraction = abs.toString().padStart(6, '0').slice(0, 4).replace(/0+$/, '');
    return `${sign}$0.${fraction.padEnd(2, '0')}`;
  }
  const cents = (abs + 5_000n) / 10_000n;
  return `${sign}$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Customer-facing amount from a decimal USDT string ("12.340000"). */
export function usdDecimal(decimal: string, options?: { signed?: boolean }): string {
  return usd(toMinor(decimal), options);
}

/** Merchant-facing amount with the settlement unit: "1,000.00 USDT". */
export function usdt(minor: bigint | string): string {
  return `${usd(minor).replace('$', '')} USDT`;
}

export function money(value: Money): string {
  return value.currency === 'USDT' ? usd(value.amountMinor) : `$${fromMinor(value.amountMinor, 2)}`;
}

/** WBT amount from wei, trimmed to 6 decimals. */
export function wbt(wei: bigint | string, places = 4): string {
  const value = typeof wei === 'bigint' ? wei : BigInt(wei);
  const scale = 10n ** 18n;
  const fraction = (value % scale).toString().padStart(18, '0').slice(0, places);
  return `${(value / scale).toString()}.${fraction} WBT`;
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const timeFormat = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
});

export const date = (iso: string) => dateFormat.format(new Date(iso));
export const dateTime = (iso: string) => `${dateTimeFormat.format(new Date(iso))} UTC`;
export const time = (iso: string) => timeFormat.format(new Date(iso));

/** "in 3 days", "2 hours ago", relative to an explicit clock so the demo clock is respected. */
export function relative(iso: string, now: string | number | Date): string {
  const diff = new Date(iso).getTime() - new Date(now).getTime();
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const format = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size || unit === 'minute') return format.format(Math.round(diff / size), unit);
  }
  return format.format(0, 'minute');
}

export function period(seconds: number): string {
  if (seconds < 3600) return seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
  const days = seconds / 86_400;
  if (days === 30 || days === 31) return 'month';
  if (days === 7) return 'week';
  if (days === 365) return 'year';
  if (Number.isInteger(days)) return days === 1 ? 'day' : `${days} days`;
  return `${Math.round(seconds / 3600)} hours`;
}

export function shortHash(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 2 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** "too_early" -> "Too early". */
export function humanize(code: string): string {
  const text = code.replaceAll('_', ' ').replaceAll('.', ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** When a renewal is due: a date for long periods, a date and time for periods under a day (test plans). */
export function chargeTime(at: string, periodSeconds: number): string {
  return periodSeconds < 86_400 ? dateTime(at) : date(at);
}
