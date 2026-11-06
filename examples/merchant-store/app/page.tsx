import Link from 'next/link';
import { STORE_ITEM } from '../lib/store.ts';

export const dynamic = 'force-dynamic';

export default function StorePage() {
  const origin = process.env.PACT_CHECKOUT_ORIGIN, product = process.env.PACT_PRODUCT_ID;
  return (
    <>
      <p style={{ fontWeight: 600 }}>STUDIO SUPPLY</p>
      <h1>{STORE_ITEM.name}</h1>
      <p>{STORE_ITEM.amount} USDT. This testnet example does not sell real goods.</p>
      <p>
        <Link href="/pay">Buy with the embedded checkout</Link>
      </p>
      {origin && product && (
        <p>
          <a href={`${origin}/buy/${encodeURIComponent(product)}`}>Or use a hosted product link</a>
        </p>
      )}
      <small>Orders are fulfilled only after a verified, signed webhook from Pact.</small>
    </>
  );
}
