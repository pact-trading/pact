import type { Address, Hex } from 'viem';

/** Deterministic PRNG so fixtures look the same after every reset. `createRandom(r.state())` resumes `r`. */
export function createRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    state: () => state,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
    hex: (bytes: number) => {
      let out = '';
      for (let i = 0; i < bytes; i++)
        out += Math.floor(next() * 256)
          .toString(16)
          .padStart(2, '0');
      return out;
    },
  };
}

export type Random = ReturnType<typeof createRandom>;

export function idFactory(random: Random, saved: Record<string, number> = {}) {
  const counters = new Map(Object.entries(saved));
  return {
    /** The counters, for persisting a sandbox; pass them back to resume. */
    counters: () => Object.fromEntries(counters),
    /** Readable sequential ids: ord_1001, ref_1002 … */
    next(prefix: string, start = 1000) {
      const value = (counters.get(prefix) ?? start) + 1;
      counters.set(prefix, value);
      return `${prefix}_${value}`;
    },
    tx: (): Hex => `0x${random.hex(32)}`,
    address: (): Address => `0x${random.hex(20)}`,
    token: (bytes = 16) => random.hex(bytes),
  };
}

export type Ids = ReturnType<typeof idFactory>;
