'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getData } from '../data';
import { DataError } from '../data/errors';
import type { ScenarioId, WebhookOutcome } from '../data/parts/lab';
import { attempt } from './result';

/** The demo lab exists only with mock data. */
const lab = async () => {
  const data = (await getData()).lab;
  if (!data) throw new DataError('not_found', 'Demo controls exist only with mock data.', 404);
  return data;
};

const done = async <T>(work: () => Promise<T>) =>
  attempt(async () => {
    const result = await work();
    revalidatePath('/', 'layout');
    return result;
  });

export const setScenario = async (id: ScenarioId) => done(async () => (await lab()).setScenario(id));

export const queueTestEvent = async () => done(async () => (await lab()).queueTestEvent());

export const simulateWebhook = async (eventId: string, outcome: WebhookOutcome) =>
  done(async () => (await lab()).simulateWebhook(eventId, outcome));

/** The store's server creates the order and its Pact checkout, then sends the shopper there. */
export async function buyFromStore(productId: string) {
  const result = await done(async () => (await lab()).buyFromStore(productId));
  if (!result.ok) return result;
  // Outside attempt(): redirect() works by throwing.
  redirect(`/checkout/${result.data.sessionId}`);
}
