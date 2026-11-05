'use client';

import { useSyncExternalStore } from 'react';

const subscribeToTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

/** Client-only: whether the document currently carries the dark theme class. */
export function useIsDarkTheme() {
  return useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.classList.contains('theme-dark'),
    () => false,
  );
}
