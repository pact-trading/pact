import type { CheckoutField } from '@pactagent/core/checkout-fields';
import type { Db } from './db.js';
import { Refusal } from './types.js';

export type Metadata = Record<string, string | number | boolean>;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/, MAX_KEYS = 20, MAX_VALUE = 500, MAX_LABEL = 120;
/** Values Pact itself reads from `payments.metadata`. Callers must never be able to set these. */
const RESERVED = new Set(['linkId', 'manualOrder', 'discountCode', 'amountGrossMinor', 'amountDiscountMinor', 'productId', 'productRevision']);
/** Control values that `POST /v1/payments` has always accepted, checked by that route. */
const CONTROL = new Set(['invoiceId', 'paymentLinkId']);
const refuse = (message: string): never => { throw new Refusal('invalid_metadata', message); };

export function initCheckoutMetadata(db: Db) {
  for (const [table, column] of [['payments', 'custom_metadata'], ['commerce_orders', 'metadata'], ['payment_links', 'checkout_fields']] as const)
    if (!(db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

/** A flat object: at most 20 keys, each value a string of up to 500 characters, a number or a boolean. */
export function validateMetadata(value: unknown): Metadata {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('Metadata must be an object');
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) refuse(`Metadata can have at most ${MAX_KEYS} keys`);
  for (const [key, item] of entries) {
    if (!KEY.test(key)) refuse(`Invalid metadata key: ${key.slice(0, 40)}`);
    if (typeof item === 'string' ? item.length > MAX_VALUE : typeof item === 'number' ? !Number.isFinite(item) : typeof item !== 'boolean') refuse(`Invalid value for metadata key: ${key}`);
  }
  return Object.fromEntries(entries) as Metadata;
}

/** Splits `POST /v1/payments` metadata into control values and the merchant's own data. */
export function splitPaymentMetadata(value: unknown) {
  const metadata = validateMetadata(value), control: Metadata = {}, custom: Metadata = {};
  for (const [key, item] of Object.entries(metadata)) {
    if (RESERVED.has(key)) refuse(`Reserved metadata key: ${key}`);
    (CONTROL.has(key) ? control : custom)[key] = item;
  }
  return { control, custom };
}

export function validateCheckoutFields(value: unknown): CheckoutField[] {
  const bad = (message: string): never => { throw new Refusal('invalid_checkout_fields', message); };
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_KEYS) return bad(`Add at most ${MAX_KEYS} checkout fields`);
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['key', 'label', 'type', 'required'].includes(k))) return bad('Invalid checkout field');
    const { key, label, type, required } = raw as Record<string, unknown>;
    if (typeof key !== 'string' || !KEY.test(key) || seen.has(key)) return bad('Each checkout field needs a unique key of letters, numbers and underscores');
    if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL || /[\u0000-\u001f]/.test(label)) return bad(`Checkout field labels must be 1 to ${MAX_LABEL} characters`);
    if (type !== 'text' && type !== 'number' && type !== 'checkbox') return bad('Checkout field type must be text, number or checkbox');
    if (required !== undefined && typeof required !== 'boolean') return bad('Checkout field required must be true or false');
    seen.add(key);
    return { key, label: label.trim(), type, ...(required ? { required: true } : {}) };
  });
}

/** Hosted checkouts: only the merchant's own questions, with the right types, and every required one answered. */
export function answersFor(fields: readonly CheckoutField[], value: unknown): Metadata {
  const answers = validateMetadata(value), known = new Map(fields.map(field => [field.key, field]));
  for (const [key, item] of Object.entries(answers)) {
    const field = known.get(key);
    if (!field) refuse(`Unknown checkout field: ${key}`);
    if (typeof item !== ({ text: 'string', number: 'number', checkbox: 'boolean' } as const)[field!.type]) refuse(`Invalid answer for ${field!.label}`);
  }
  for (const field of fields) {
    const answer = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    if (field.required && (answer === undefined || answer === false || (typeof answer === 'string' && !answer.trim()))) throw new Refusal('checkout_field_required', `${field.label} is required`);
  }
  return answers;
}

export const storedMetadata = (value: unknown) => JSON.parse(String(value ?? '{}')) as Metadata;
export const storedCheckoutFields = (value: unknown) => JSON.parse(String(value ?? '[]')) as CheckoutField[];
