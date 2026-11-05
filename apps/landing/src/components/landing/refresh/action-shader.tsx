'use client';
import { ShaderBackground } from '@/components/ui/verdant-swirl';
import { useIsDarkTheme } from '@/lib/use-dark-theme';

// Three close tones per action so the waves read as a quiet shimmer under the label.
const ACTION_WAVES = {
  blue: [
    [0.808, 0.988, 0.353],
    [0.800, 0.988, 0.318],
    [0.835, 0.992, 0.443],
  ],
  gray: [
    [0.906, 0.918, 0.878],
    [0.945, 0.953, 0.925],
    [0.980, 0.984, 0.969],
  ],
  grayDark: [
    [0.122, 0.133, 0.086],
    [0.153, 0.169, 0.110],
    [0.188, 0.208, 0.141],
  ],
} as const;

/** Live wave fill for actions; the CSS gradient underneath is the fallback. */
export function ActionShader({ tone = 'blue' }: { tone?: 'blue' | 'gray' }) {
  const dark = useIsDarkTheme();
  const palette = tone === 'gray' && dark ? 'grayDark' : tone;
  return (
    <ShaderBackground
      className="action-shader"
      preset="waves"
      colors={ACTION_WAVES[palette]}
      grain={tone === 'gray' ? 0.03 : 0.05}
      paramA={3.2}
    />
  );
}

// CTA band waves: light brand blues under dark copy. The band stays light in both themes.
const CTA_WAVES = [
  [0.027, 0.035, 0.016],
  [0.086, 0.122, 0.024],
  [0.243, 0.345, 0.039],
  [0.588, 0.804, 0.149],
] as const;

/** Waves behind the closing CTA; the still backdrop image stays underneath as the fallback. */
export function CtaWaves() {
  return (
    <ShaderBackground
      className="cta-backdrop cta-waves"
      preset="waves"
      colors={CTA_WAVES}
      grain={0.085}
      paramA={1.6}
      speed={1.8}
    />
  );
}
