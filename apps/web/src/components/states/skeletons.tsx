import { cn } from '@/lib/cn';
import { Card } from '../ui/card';

/** One placeholder bar. */
export function Bone({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-lg bg-chip', className)} />;
}

function Busy({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

function TableCard({ rows = 6 }: { rows?: number }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <Bone className="h-5 w-40" />
        <Bone className="h-9 w-24 rounded-full" />
      </div>
      <div className="divide-y divide-border-subtle">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-3.5">
            <div className="grid min-w-0 flex-1 gap-1.5">
              <Bone className={cn('h-4', i % 2 ? 'w-1/2' : 'w-2/3')} />
              <Bone className="h-3 w-1/3" />
            </div>
            <Bone className="hidden h-6 w-20 rounded-full sm:block" />
            <Bone className="h-4 w-16" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** A merchant page loading inside the dashboard shell. */
export function DashboardSkeleton() {
  return (
    <Busy label="Loading…">
      <div className="mb-6 grid gap-2.5">
        <Bone className="h-8 w-48 sm:h-9" />
        <Bone className="h-4 w-full max-w-md" />
      </div>
      <div className="mb-4 flex gap-1.5">
        {['w-16', 'w-20', 'w-14', 'w-18'].map(w => (
          <Bone key={w} className={cn('h-9 rounded-full', w)} />
        ))}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map(i => (
          <Card key={i} className="grid gap-2.5 p-5">
            <Bone className="h-3.5 w-20" />
            <Bone className="h-7 w-28" />
          </Card>
        ))}
      </div>
      <TableCard />
    </Busy>
  );
}

/** A customer portal page loading inside the portal shell. */
export function PortalSkeleton() {
  return (
    <Busy label="Loading…">
      <div className="mb-6 grid gap-2.5">
        <Bone className="h-8 w-44" />
        <Bone className="h-4 w-full max-w-sm" />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        {[0, 1].map(i => (
          <Card key={i} className="grid gap-3 p-5">
            <Bone className="h-4 w-24" />
            <Bone className="h-8 w-32" />
            <Bone className="h-3.5 w-2/3" />
          </Card>
        ))}
      </div>
      <TableCard rows={4} />
    </Busy>
  );
}

/** A payment page loading: the business header, the order summary and the payment card. */
export function CheckoutSkeleton() {
  return (
    <Busy label="Loading the payment page…" className="min-h-[calc(100dvh-2.5rem)] [.no-demo_&]:min-h-dvh">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 pt-6">
        <Bone className="size-9 rounded-xl" />
        <Bone className="h-4 w-28" />
      </div>
      <div className="mx-auto grid max-w-5xl gap-8 px-5 pt-8 pb-12 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)] md:gap-12 md:pt-14">
        <div className="grid content-start gap-3">
          <Bone className="h-4 w-32" />
          <Bone className="h-9 w-3/4" />
          <Bone className="mt-2 h-12 w-40" />
          <Bone className="mt-2 h-4 w-full max-w-md" />
          <Bone className="h-4 w-2/3 max-w-sm" />
        </div>
        <div className="grid gap-4 rounded-3xl border border-border bg-card p-6 shadow-panel sm:p-7">
          <Bone className="h-4 w-40" />
          <Bone className="h-6 w-36" />
          <div className="grid gap-3 rounded-2xl border border-border p-4">
            <Bone className="h-4 w-full" />
            <Bone className="h-4 w-5/6" />
            <Bone className="h-5 w-2/3" />
          </div>
          <Bone className="h-13 w-full rounded-full" />
        </div>
      </div>
    </Busy>
  );
}
