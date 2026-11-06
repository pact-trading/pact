export interface BackgroundJob { name: string; intervalMs: number; run: () => Promise<unknown> }
/** Stops every job. `kick(name)` runs a job now instead of at its next tick (e.g. when a block lands). */
export type BackgroundJobs = (() => void) & { kick: (name: string) => void };

/** Each job owns its in-flight guard. A slow RPC cannot block signed webhook
 * deliveries, and a slow delivery cannot create overlapping indexer/keeper runs.
 * A kick while a job runs is remembered once and runs right after it, never in parallel. */
export function startBackgroundJobs(jobs: BackgroundJob[], onError: (name: string, error: unknown) => void): BackgroundJobs {
  let stopped = false;
  const runners = new Map<string, (kicked?: boolean) => void>();
  const timers = jobs.map(job => {
    let busy = false, again = false;
    // Timer ticks during a run are dropped, as before; a kick during a run is kept for right after it.
    const tick = (kicked = false) => {
      if (stopped) return;
      if (busy) { if (kicked) again = true; return; }
      busy = true;
      void Promise.resolve().then(job.run).catch(error => onError(job.name, error)).finally(() => {
        busy = false;
        if (again && !stopped) { again = false; tick(); }
      });
    };
    runners.set(job.name, tick);
    const timer = setInterval(() => tick(), job.intervalMs);
    timer.unref();
    return timer;
  });
  // In-flight writes retain their ownership and finish normally.
  const stop = (() => { stopped = true; timers.forEach(clearInterval); }) as BackgroundJobs;
  stop.kick = name => runners.get(name)?.(true);
  return stop;
}
