/** Platform-neutral checkout appearance tokens shared by web and native. */
export interface PactTheme {
  type: 'dark' | 'light';
  colors: {
    primary: string;
    primaryText: string;
    background: string;
    surface: string;
    text: string;
    mutedText: string;
    border: string;
    success: string;
    danger: string;
  };
  /** Corner radius in pixels. */
  radius: number;
  /** CSS font stack on web; preferred family name on native. */
  font: string;
  brand: { name: string; logo?: string };
}

export type PactThemeOptions = Partial<Omit<PactTheme, 'colors' | 'brand'>> & {
  colors?: Partial<PactTheme['colors']>;
  brand?: Partial<PactTheme['brand']>;
};

export const pactThemePresets: Record<'dark' | 'light', PactTheme> = {
  light: {
    type: 'light',
    colors: { primary: '#c6ff34', primaryText: '#0a0d02', background: '#f3f4f6', surface: '#ffffff', text: '#0e1116', mutedText: '#646b78', border: '#e4e6ea', success: '#4d7c0f', danger: '#b42318' },
    radius: 16,
    font: 'Geist Variable, system-ui, sans-serif',
    brand: { name: 'Pact Pay' },
  },
  dark: {
    type: 'dark',
    colors: { primary: '#c6ff34', primaryText: '#0a0d02', background: '#090909', surface: '#121212', text: '#f2f3f5', mutedText: '#8e95a2', border: '#262626', success: '#b5f23d', danger: '#ff8a7a' },
    radius: 16,
    font: 'Geist Variable, system-ui, sans-serif',
    brand: { name: 'Pact Pay' },
  },
};

/** Choose the higher-contrast label for editable brand colors (WCAG luminance). */
export function primaryTextColor(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#0a0d02';
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return luminance > 0.179 ? '#0a0d02' : '#ffffff';
}

export function pactTheme(options: PactThemeOptions = {}): PactTheme {
  const preset = pactThemePresets[options.type ?? 'light'];
  const radius = options.radius ?? preset.radius;
  if (!Number.isFinite(radius) || radius < 0 || radius > 48) throw new RangeError('Theme radius must be between 0 and 48');
  return {
    type: preset.type,
    colors: { ...preset.colors, ...options.colors, primaryText: options.colors?.primaryText ?? (options.colors?.primary ? primaryTextColor(options.colors.primary) : preset.colors.primaryText) },
    radius,
    font: options.font ?? preset.font,
    brand: { ...preset.brand, ...options.brand },
  };
}

/** CSS custom properties are scoped to a checkout root, never the host page. */
export function themeToCssVariables(theme: PactTheme): Record<string, string> {
  return {
    '--pact-checkout-primary': theme.colors.primary,
    '--pact-checkout-primary-text': theme.colors.primaryText,
    '--pact-checkout-background': theme.colors.background,
    '--pact-checkout-surface': theme.colors.surface,
    '--pact-checkout-text': theme.colors.text,
    '--pact-checkout-muted-text': theme.colors.mutedText,
    '--pact-checkout-border': theme.colors.border,
    '--pact-checkout-success': theme.colors.success,
    '--pact-checkout-danger': theme.colors.danger,
    '--pact-checkout-radius': `${theme.radius}px`,
    '--pact-checkout-font': theme.font,
  };
}
