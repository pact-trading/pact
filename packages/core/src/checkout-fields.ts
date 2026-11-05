/** An extra question on a checkout. Answers are saved on the order as `metadata`. */
export type CheckoutFieldType = 'text' | 'number' | 'checkbox';
export interface CheckoutField { key: string; label: string; type: CheckoutFieldType; required?: boolean }
export type CheckoutAnswer = string | boolean;
export type MetadataValue = string | number | boolean;
export type CheckoutMetadata = Record<string, MetadataValue>;
export const MAX_METADATA_VALUE_LENGTH = 500;

/**
 * Checks a customer's answers and turns them into metadata. Empty optional answers are left out, and
 * an unticked optional checkbox is left out too. The server repeats these checks for hosted checkouts.
 */
export function validateCheckoutAnswers(fields: readonly CheckoutField[], answers: Readonly<Record<string, CheckoutAnswer | undefined>>) {
  const metadata: CheckoutMetadata = {}, errors: Record<string, string> = {};
  for (const field of fields) {
    const answer = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    if (field.type === 'checkbox') {
      if (answer === true) metadata[field.key] = true;
      else if (field.required) errors[field.key] = `${field.label} is required.`;
      continue;
    }
    const text = typeof answer === 'string' ? answer.trim() : '';
    if (!text) {
      if (field.required) errors[field.key] = `${field.label} is required.`;
    } else if (text.length > MAX_METADATA_VALUE_LENGTH) errors[field.key] = `${field.label} must be ${MAX_METADATA_VALUE_LENGTH} characters or fewer.`;
    else if (field.type === 'number') {
      const value = Number(text);
      if (Number.isFinite(value)) metadata[field.key] = value;
      else errors[field.key] = `${field.label} must be a number.`;
    } else metadata[field.key] = text;
  }
  return { metadata, errors, valid: Object.keys(errors).length === 0 };
}
