import { describe, expect, it } from 'vitest';
import { pactTheme, pactThemePresets, themeToCssVariables } from '../src/index.js';

describe('settle checkout themes', () => {
  it('merges partial colors into the selected preset without mutating it', () => {
    const before = pactThemePresets.dark.colors.primary;
    const theme = pactTheme({ type: 'dark', colors: { primary: '#166534' }, brand: { name: 'Studio' } });
    expect(theme.type).toBe('dark');
    expect(theme.colors.primary).toBe('#166534');
    expect(theme.colors.text).toBe(pactThemePresets.dark.colors.text);
    expect(theme.brand.name).toBe('Studio');
    expect(pactThemePresets.dark.colors.primary).toBe(before);
  });

  it('maps platform-neutral tokens to scoped CSS variables', () => {
    const theme = pactTheme({ radius: 20, font: 'Inter', colors: { primary: '#123456' } });
    expect(themeToCssVariables(theme)).toMatchObject({ '--pact-checkout-primary': '#123456', '--pact-checkout-radius': '20px', '--pact-checkout-font': 'Inter' });
  });

  it('uses Pact Pay light tokens and emits every CSS token', () => {
    const theme = pactTheme();
    expect(theme).toEqual({
      type: 'light',
      colors: { primary: '#c6ff34', primaryText: '#0a0d02', background: '#f3f4f6', surface: '#ffffff', text: '#0e1116', mutedText: '#646b78', border: '#e4e6ea', success: '#4d7c0f', danger: '#b42318' },
      radius: 16,
      font: 'Geist Variable, system-ui, sans-serif',
      brand: { name: 'Pact Pay' },
    });
    expect(themeToCssVariables(theme)).toEqual({
      '--pact-checkout-primary': '#c6ff34', '--pact-checkout-primary-text': '#0a0d02',
      '--pact-checkout-background': '#f3f4f6', '--pact-checkout-surface': '#ffffff',
      '--pact-checkout-text': '#0e1116', '--pact-checkout-muted-text': '#646b78',
      '--pact-checkout-border': '#e4e6ea', '--pact-checkout-success': '#4d7c0f',
      '--pact-checkout-danger': '#b42318', '--pact-checkout-radius': '16px',
      '--pact-checkout-font': 'Geist Variable, system-ui, sans-serif',
    });
  });

  it('keeps custom brand colours readable and respects an explicit label colour', () => {
    expect(pactTheme({ colors: { primary: '#123456' } }).colors.primaryText).toBe('#ffffff');
    expect(pactTheme({ colors: { primary: '#c6ff34' } }).colors.primaryText).toBe('#0a0d02');
    expect(pactTheme({ colors: { primary: '#123456', primaryText: '#eeeeee' } }).colors.primaryText).toBe('#eeeeee');
  });

  it('rejects invalid radii', () => {
    expect(() => pactTheme({ radius: -1 })).toThrow(RangeError);
    expect(() => pactTheme({ radius: Number.NaN })).toThrow(RangeError);
  });
});
