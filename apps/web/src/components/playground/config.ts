import type { CSSProperties } from 'react';
import { pactTheme, primaryTextColor, type PactTheme } from '@pactagent/core/theme';
import type { CheckoutStep } from '../customer/checkout/panel';

export { primaryTextColor } from '@pactagent/core/theme';

export type PaymentType = 'one-time' | 'recurring' | 'invoice';
export type PreviewStep = CheckoutStep;
export type PreviewMethod = 'account' | 'card' | 'bank';
export type EmbedMode = 'link' | 'inline' | 'modal';
export type FontChoice = 'system' | 'serif' | 'mono';
export type Device = 'desktop' | 'phone';

export interface PlaygroundFeatures {
  promo: boolean;
  tax: boolean;
  upsell: boolean;
  lowBalance: boolean;
  phone: boolean;
  billing: boolean;
  shipping: boolean;
}

export interface PlaygroundConfig {
  type: PaymentType;
  features: PlaygroundFeatures;
  /** At least one, in the order account, card, bank. */
  methods: PreviewMethod[];
  /** Decimal dollars, up to two places. */
  amount: string;
  /** The information step's button. */
  buttonLabel: string;
  theme: 'light' | 'dark';
  primary: string;
  radius: number;
  font: FontChoice;
  brandName: string;
  /** A data: URL, or empty. */
  logo: string;
  embed: EmbedMode;
}

/** What the preview shows, kept in share links alongside the configuration. */
export interface PlaygroundView {
  step: PreviewStep;
  device: Device;
}

export const allMethods: PreviewMethod[] = ['account', 'card', 'bank'];

export const defaultConfig: PlaygroundConfig = {
  type: 'one-time',
  features: {
    promo: false,
    tax: false,
    upsell: false,
    lowBalance: false,
    phone: false,
    billing: false,
    shipping: false,
  },
  methods: ['account', 'card'],
  amount: '125.00',
  buttonLabel: 'Continue to payment',
  theme: 'light',
  primary: '#c6ff34',
  radius: 16,
  font: 'system',
  brandName: 'Northstar Studio',
  logo: '',
  embed: 'link',
};

export const defaultView: PlaygroundView = { step: 'payment', device: 'desktop' };

export const fonts: Record<FontChoice, string> = {
  system: '"Geist Variable", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Geist Mono Variable", ui-monospace, monospace',
};

export const LIMITS = { brandName: 60, buttonLabel: 40, radius: 24, amount: 9_999_999 } as const;
/** Uploads stay in the tab up to this size; share links carry the logo only below `sharedLogo`. */
export const LOGO_BYTES = 24_000;
export const SHARED_LOGO_CHARS = 3_000;

export const amountPattern = /^\d{1,7}(\.\d{1,2})?$/;
export const validAmount = (value: string) => amountPattern.test(value) && Number(value) > 0;

export function configTheme(config: PlaygroundConfig): PactTheme {
  return pactTheme({
    type: config.theme,
    colors: { primary: config.primary, primaryText: primaryTextColor(config.primary) },
    radius: config.radius,
    font: fonts[config.font],
    brand: { name: config.brandName, logo: config.logo || undefined },
  });
}

/** CSS variables that restyle the shared checkout inside the preview, and nothing outside it. */
export function previewStyle(config: PlaygroundConfig): CSSProperties {
  return {
    '--primary': config.primary,
    '--primary-foreground': primaryTextColor(config.primary),
    '--checkout-radius': `${config.radius}px`,
    '--checkout-button-radius': config.radius >= 12 ? '9999px' : `${config.radius}px`,
    fontFamily: fonts[config.font],
  } as CSSProperties;
}

// ------------------------------------------------------------ share links
//
// Short, readable query params, written only when a setting differs from its default. Reading
// checks each param on its own: an unknown or malformed value is ignored and that setting keeps
// its default, so an old or hand-edited link still opens.

const typeCodes = { once: 'one-time', recurring: 'recurring', invoice: 'invoice' } as const;
const featureCodes = {
  promo: 'promo',
  tax: 'tax',
  upsell: 'upsell',
  low: 'lowBalance',
  phone: 'phone',
  billing: 'billing',
  shipping: 'shipping',
} as const satisfies Record<string, keyof PlaygroundFeatures>;
const methodCodes = { account: 'account', card: 'card', bank: 'bank' } as const;
const layoutCodes = { page: 'link', inline: 'inline', popup: 'modal' } as const;
const fontCodes = { geist: 'system', serif: 'serif', mono: 'mono' } as const;
const themeCodes = { light: 'light', dark: 'dark' } as const;
const stepCodes = {
  info: 'information',
  pay: 'payment',
  processing: 'processing',
  paid: 'success',
  refund: 'refund',
  expired: 'expired',
  failed: 'failed',
} as const satisfies Record<string, PreviewStep>;
const deviceCodes = { desktop: 'desktop', phone: 'phone' } as const;

/** Looks a code up in a table, refusing inherited keys such as "constructor" or "__proto__". */
function lookup<T extends Record<string, string>>(table: T, code: string | null): T[keyof T] | undefined {
  return code !== null && Object.hasOwn(table, code) ? table[code as keyof T] : undefined;
}

function codeOf<T extends Record<string, string>>(table: T, value: string): string {
  return Object.keys(table).find(key => table[key] === value)!;
}

const logoPattern = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export const shareableLogo = (logo: string) => logo.length <= SHARED_LOGO_CHARS;

export function configToSearch(config: PlaygroundConfig, view: PlaygroundView): string {
  const q = new URLSearchParams();
  const d = defaultConfig;
  if (config.type !== d.type) q.set('t', codeOf(typeCodes, config.type));
  const features = Object.entries(featureCodes)
    .filter(([, key]) => config.features[key])
    .map(([code]) => code);
  if (features.length) q.set('f', features.join(','));
  if (config.methods.join() !== d.methods.join()) q.set('m', config.methods.join(','));
  if (config.amount !== d.amount) q.set('amt', config.amount);
  if (config.buttonLabel !== d.buttonLabel) q.set('cta', config.buttonLabel);
  if (config.embed !== d.embed) q.set('l', codeOf(layoutCodes, config.embed));
  if (config.theme !== d.theme) q.set('theme', config.theme);
  if (config.primary.toLowerCase() !== d.primary) q.set('c', config.primary.slice(1).toLowerCase());
  if (config.radius !== d.radius) q.set('r', String(config.radius));
  if (config.font !== d.font) q.set('font', codeOf(fontCodes, config.font));
  if (config.brandName !== d.brandName) q.set('name', config.brandName);
  if (config.logo && shareableLogo(config.logo)) q.set('logo', config.logo);
  if (view.step !== defaultView.step) q.set('s', codeOf(stepCodes, view.step));
  if (view.device !== defaultView.device) q.set('d', view.device);
  const search = q.toString().replace(/%2C/g, ',');
  return search ? `?${search}` : '';
}

export function configFromSearch(q: URLSearchParams): { config: PlaygroundConfig; view: PlaygroundView } {
  const config: PlaygroundConfig = { ...defaultConfig, features: { ...defaultConfig.features } };
  const view: PlaygroundView = { ...defaultView };

  const type = lookup(typeCodes, q.get('t'));
  if (type) config.type = type;

  const features = q.get('f');
  if (features !== null) {
    const keys = features
      .split(',')
      .map(code => lookup(featureCodes, code))
      .filter(key => key !== undefined);
    for (const key of keys) config.features[key] = true;
  }

  const methods = q.get('m');
  if (methods !== null) {
    const chosen = new Set(methods.split(',').map(code => lookup(methodCodes, code)));
    const list = allMethods.filter(method => chosen.has(method));
    if (list.length) config.methods = list;
  }

  const amount = q.get('amt');
  if (amount !== null && validAmount(amount)) config.amount = amount;

  const label = q.get('cta');
  if (label !== null && label.length <= LIMITS.buttonLabel) config.buttonLabel = label;

  const layout = lookup(layoutCodes, q.get('l'));
  if (layout) config.embed = layout;

  const theme = lookup(themeCodes, q.get('theme'));
  if (theme) config.theme = theme;

  const color = q.get('c');
  if (color !== null && /^[0-9a-f]{6}$/i.test(color)) config.primary = `#${color.toLowerCase()}`;

  const radius = q.get('r');
  if (radius !== null && /^\d{1,2}$/.test(radius) && Number(radius) <= LIMITS.radius)
    config.radius = Number(radius);

  const font = lookup(fontCodes, q.get('font'));
  if (font) config.font = font;

  const name = q.get('name');
  if (name !== null && name.length <= LIMITS.brandName) config.brandName = name;

  const logo = q.get('logo');
  if (logo !== null && shareableLogo(logo) && logoPattern.test(logo)) config.logo = logo;

  const step = lookup(stepCodes, q.get('s'));
  if (step) view.step = step;

  const device = lookup(deviceCodes, q.get('d'));
  if (device) view.device = device;

  return { config, view };
}
