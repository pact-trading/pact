import type { CardDetails } from '@/server/data/types';

/**
 * Card validation shared by the checkout form (inline errors) and the mock data source
 * (the decision). Pure, so the server and the browser apply the same rules.
 */

/** The demo test card that always declines. */
export const DECLINE_CARD = '4000000000000002';
export const DECLINE_CARD_LABEL = '4000 0000 0000 0002';

export type CardErrors = Partial<Record<keyof CardDetails, string>>;

export const digitsOnly = (value: string) => value.replace(/\D/g, '');

/** Luhn checksum, the check digit every card number carries. */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function cardBrand(digits: string): string {
  if (/^4/.test(digits)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^6(011|5)/.test(digits)) return 'Discover';
  return 'Card';
}

/** "4242424242424242" → "4242 4242 4242 4242"; Amex groups as 4-6-5. */
export function formatCardNumber(value: string): string {
  const digits = digitsOnly(value).slice(0, 19);
  if (/^3[47]/.test(digits))
    return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)].filter(Boolean).join(' ');
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Typing "1230" becomes "12 / 30". */
export function formatExpiry(value: string): string {
  const digits = digitsOnly(value).slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
}

/** The month and year an "MM / YY" expiry names, or null if it is not a real month. */
export function parseExpiry(value: string): { month: number; year: number } | null {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{2})\s*$/.exec(value);
  if (!match) return null;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + Number(match[2]) };
}

/** Field-by-field problems with a card, judged at `nowMs`. Empty when the card can be charged. */
export function cardErrors(card: CardDetails, nowMs: number): CardErrors {
  const errors: CardErrors = {};
  const name = String(card.name ?? '').trim();
  const number = digitsOnly(String(card.number ?? ''));
  const cvc = String(card.cvc ?? '').trim();
  if (name.length < 2) errors.name = 'Enter the name on the card.';
  else if (name.length > 80) errors.name = 'Use at most 80 characters.';
  if (!number) errors.number = 'Enter the card number.';
  else if (number.length < 12 || number.length > 19 || !luhn(number))
    errors.number = 'This card number is not valid. Check the digits.';
  const expiry = parseExpiry(String(card.expiry ?? ''));
  if (!String(card.expiry ?? '').trim()) errors.expiry = 'Enter the expiry date.';
  else if (!expiry) errors.expiry = 'Use MM / YY, for example 08 / 29.';
  else {
    const now = new Date(nowMs);
    // A card is valid through the last day of its expiry month.
    const endsAt = Date.UTC(expiry.year, expiry.month, 1);
    if (endsAt <= now.getTime()) errors.expiry = 'This card has expired.';
    else if (expiry.year > now.getUTCFullYear() + 20) errors.expiry = 'Check the expiry year.';
  }
  if (!cvc) errors.cvc = 'Enter the security code.';
  else if (!/^\d{3,4}$/.test(cvc)) errors.cvc = 'The security code is 3 or 4 digits.';
  return errors;
}

/** "Visa ending 4242": all that is kept of a card. */
export function cardLabel(number: string): string {
  const digits = digitsOnly(number);
  return `${cardBrand(digits)} ending ${digits.slice(-4)}`;
}
