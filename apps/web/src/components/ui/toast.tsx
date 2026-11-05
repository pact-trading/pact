'use client';

import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; message: string; tone: 'success' | 'danger' };
const ToastContext = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts(list => [...list.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 4200);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:right-6 sm:left-auto sm:items-end"
      >
        {toasts.map(t => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex max-w-sm animate-rise-in items-center gap-2.5 rounded-2xl bg-foreground px-4 py-3 text-sm font-medium text-background shadow-pop"
          >
            {t.tone === 'success' ? (
              <IconCircleCheck className="size-4.5 shrink-0 text-primary" />
            ) : (
              <IconAlertTriangle className="size-4.5 shrink-0 text-[var(--pact-bad-soft)]" />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
