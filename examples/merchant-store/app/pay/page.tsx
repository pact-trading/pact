'use client';
import { Checkout } from '@pactagent/checkout-react';
import { STORE_ITEM } from '../../lib/store.ts';

export default function PayPage() {
  return (
    <Checkout
      amount={STORE_ITEM.amount}
      apiBaseUrl="/api/pact"
      appearance={{ brand: { name: 'Studio Supply' } }}
      onSuccess={(payment) => {
        window.location.assign(`/orders/confirm?payment_id=${encodeURIComponent(payment.id)}`);
      }}
      onError={(error) => console.error(error)}
    />
  );
}
