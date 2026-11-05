'use client';

import { IconPrinter } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '../ui/button';

/**
 * When printing, only the marked area shows, in light colours, whatever shell surrounds it:
 * everything else is hidden and the area's ancestors lose their layout. Elements marked
 * `data-print-hide` (like the print button) are left out.
 */
const css = `
@media print {
  @page { margin: 16mm; }
  body *:not([data-print-area]):not([data-print-area] *):not(:has([data-print-area])) {
    display: none !important;
  }
  :has([data-print-area]) {
    display: block !important; position: static !important; overflow: visible !important;
    width: auto !important; max-width: none !important; height: auto !important; min-height: 0 !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important; box-shadow: none !important;
    background: #fff !important; transform: none !important;
  }
  [data-print-area] {
    --card: #fff; --background: #fff; --raised: #f7f7f8; --foreground: #0e1116;
    --card-foreground: #0e1116; --subtle-foreground: #3a404b; --muted-foreground: #5a606c;
    --border: #d9dce1; --border-subtle: #e6e8ec; --chip: #eef0f3; --success: #3f6a08;
    --success-soft: #ecfccb; --warning: #7a4e00; --warning-soft: #fbf0d6;
    color: #0e1116 !important; background: #fff !important;
  }
  [data-print-area] .shadow-panel { box-shadow: none !important; }
  [data-print-area] [data-print-hide] { display: none !important; }
}`;

export function Printable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-print-area className={className}>
      <style>{css}</style>
      {children}
    </div>
  );
}

export function PrintButton({ label = 'Print receipt', className }: { label?: string; className?: string }) {
  return (
    <Button size="sm" className={cn(className)} data-print-hide onClick={() => window.print()}>
      <IconPrinter className="size-4" />
      {label}
    </Button>
  );
}
