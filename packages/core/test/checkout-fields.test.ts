import { describe, expect, it } from 'vitest';
import { validateCheckoutAnswers, type CheckoutField } from '../src/checkout-fields.js';

const fields: CheckoutField[] = [
  { key: 'company', label: 'Company', type: 'text', required: true },
  { key: 'seats', label: 'Seats', type: 'number' },
  { key: 'terms', label: 'Terms', type: 'checkbox', required: true },
  { key: 'news', label: 'News', type: 'checkbox' },
];

describe('checkout field answers', () => {
  it('requires text with content and a ticked required checkbox', () => {
    expect(validateCheckoutAnswers(fields, {}).errors).toEqual({ company: 'Company is required.', terms: 'Terms is required.' });
    expect(validateCheckoutAnswers(fields, { company: '   ', terms: false }).valid).toBe(false);
  });
  it('returns typed metadata and leaves out empty optional answers', () => {
    expect(validateCheckoutAnswers(fields, { company: ' Acme ', seats: '0', terms: true, news: false })).toEqual({ metadata: { company: 'Acme', seats: 0, terms: true }, errors: {}, valid: true });
    expect(validateCheckoutAnswers(fields, { company: 'Acme', seats: '', terms: true }).metadata).toEqual({ company: 'Acme', terms: true });
  });
  it('refuses a non-number and an over-long answer', () => {
    expect(validateCheckoutAnswers(fields, { company: 'a'.repeat(501), seats: 'many', terms: true }).errors).toEqual({ company: 'Company must be 500 characters or fewer.', seats: 'Seats must be a number.' });
  });
  it('does not read inherited object properties as answers', () => {
    expect(validateCheckoutAnswers([{ key: 'toString', label: 'Name', type: 'text', required: true }], {}).valid).toBe(false);
  });
});
