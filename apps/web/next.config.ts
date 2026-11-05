import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // A separate dist dir for `next dev` keeps a running dev server alive while `next build` runs in the same folder.
  distDir:
    process.env.PACT_PREVIEW === '1'
      ? '.next-preview'
      : process.env.PACT_LIVE === '1'
        ? '.next-live'
        : process.env.NODE_ENV === 'development'
          ? '.next-dev'
          : '.next',
  devIndicators: false,
  // One switch for both server and browser code: PACT_DATA=mock serves the demo store.
  env: { NEXT_PUBLIC_PACT_DATA: process.env.PACT_DATA === 'mock' ? 'mock' : 'api' },
  webpack(config) {
    // SDK packages are consumed from source and use NodeNext-style `.js` import suffixes.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
export default nextConfig;
