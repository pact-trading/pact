'use client';

import { IconMoon, IconSun } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export const THEME_KEY = 'pact-theme';

/** Inline script for <head>: applies the saved theme before first paint. */
export const themeScript = `try{var t=localStorage.getItem('${THEME_KEY}');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;var c=document.documentElement.classList;c.remove('theme-light','theme-dark');c.add(d?'theme-dark':'theme-light')}catch(e){}`;

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('theme-dark')), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    const classes = document.documentElement.classList;
    classes.toggle('theme-dark', next);
    classes.toggle('theme-light', !next);
    localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={cn(
        'grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-chip hover:text-foreground',
        className,
      )}
    >
      {dark ? <IconSun className="size-4.5" /> : <IconMoon className="size-4.5" />}
    </button>
  );
}
