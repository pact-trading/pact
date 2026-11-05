export interface BackgroundJob { name: string; intervalMs: number; run: () => Promise<unknown> }

/** Each job owns its in-flight guard. A slow RPC cannot block signed webhook
 * deliveries, and a slow delivery cannot create overlapping indexer/keeper runs. */
export function startBackgroundJobs(jobs: BackgroundJob[], onError: (name: string, error: unknown) => void) {
  const timers = jobs.map(job => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void Promise.resolve().then(job.run).catch(error => onError(job.name, error)).finally(() => { busy = false; });
    }, job.intervalMs);
    timer.unref();
    return timer;
  });
  // In-flight writes retain their ownership and finish normally.
  return () => timers.forEach(clearInterval);
}
