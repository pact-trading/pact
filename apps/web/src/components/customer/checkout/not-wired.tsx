import { NotConnected } from '../../states/not-connected';

/** A checkout route whose API endpoint is still on the wiring backlog. */
export function CheckoutNotWired({ feature }: { feature: string }) {
  return (
    <main className="mx-auto grid min-h-[calc(100dvh-2.5rem)] max-w-lg content-center px-5 py-10 [.no-demo_&]:min-h-dvh">
      <NotConnected feature={feature} />
    </main>
  );
}
