'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { initSections } from './section-motion';
import { initReveals } from './reveal-motion';

/** Owns the demo lifecycle; static section content remains server rendered. */
export function LandingRuntime({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const visibility = { current: true };
    // The hero cards animate themselves (app-cards); sections only need play/pause hooks.
    const hero = { play() {}, pause() {}, destroy() {} };
    const sections = initSections(root, hero, visibility);
    const stopReveals = initReveals(root);
    root.dataset.ready = 'true';
    return () => {
      delete root.dataset.ready;
      stopReveals();
      sections.destroy();
      hero.destroy();
    };
  }, []);
  return (
    <div ref={ref} className="gol-landing">
      {children}
    </div>
  );
}
