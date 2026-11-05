// Synthetic process fixture only: no app, chain adapter, key material, RPC or DB.
import { writeFileSync } from 'node:fs';
import { startOwnedRelayer } from '../../src/runtime-ownership.js';
const [chainId, relayer, marker] = process.argv.slice(2);
try {
  await startOwnedRelayer({ chainId: Number(chainId), relayer }, () => {
    writeFileSync(marker, 'jobs-and-http-started');
    process.send?.({ status: 'owned', db: process.env.DATABASE_PATH });
    // A held event loop models the running HTTP service independently of its DB.
    setInterval(() => {}, 1000);
    let draining = false;
    process.on('message', message => {
      if (message === 'drain') {
        draining = true;
        process.send?.({ status: 'draining' });
        // Finish only when the parent has exercised a competing process.
      }
      if (message === 'finish' && draining) process.exit(0);
    });
  });
} catch (error) {
  process.send?.({ status: 'blocked', message: error instanceof Error ? error.message : 'failure' }, () => process.exit(1));
}
