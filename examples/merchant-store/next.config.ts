import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  // This example lives in the pact-pay workspace.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};
export default nextConfig;
