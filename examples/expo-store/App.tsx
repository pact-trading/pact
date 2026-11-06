import React from 'react';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import { PactClient, fetchTransport } from '@pactagent/core';
import { PactCheckout } from '@pactagent/react-native';

const storage = { getItem: SecureStore.getItemAsync, setItem: SecureStore.setItemAsync, deleteItem: SecureStore.deleteItemAsync };
const proxyUrl = process.env.EXPO_PUBLIC_PACT_PROXY_URL;
export default function App() {
  if (!proxyUrl) throw new Error('Set EXPO_PUBLIC_PACT_PROXY_URL to your merchant proxy');
  const client = new PactClient({ transport: fetchTransport(proxyUrl) });
  return <PactCheckout amount="12.50" client={client}
    returnUrl={Linking.createURL('payment-return')} storage={storage}
    onSuccess={(payment) => console.log('Paid', payment.id)} />;
}
