/** Stage timings for diagnosis, logged only with PACT_TIMING=1. */
export function stopwatch(label: string) {
  if (process.env.PACT_TIMING !== '1') return { lap: (_stage: string) => {}, done: () => {} };
  const start = performance.now(); let last = start; const laps: string[] = [];
  return {
    lap(stage: string) { const t = performance.now(); laps.push(`${stage}=${Math.round(t - last)}`); last = t; },
    done() { console.info(`[timing] ${label} total=${Math.round(performance.now() - start)}ms ${laps.join(' ')}`); },
  };
}
