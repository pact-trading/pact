'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ViewerRole } from '@pactagent/core/platform-types';
import { getData } from '../data';
import { isMock } from '../mode';
import { ROLE_COOKIE } from '../viewer';
import { attempt } from './result';

const landing: Record<ViewerRole, string> = {
  merchant: '/dashboard',
  accountant: '/dashboard/exports',
  customer: '/portal',
  investor: '/investor',
  compliance: '/compliance',
};
const safePath = (path: string | undefined) =>
  path && path.startsWith('/') && !path.startsWith('//') ? path : undefined;

/** Picks a viewpoint. In mock mode this is the whole sign-in; with the API it only records the chosen side. */
export async function chooseViewer(role: ViewerRole, next?: string) {
  if (!Object.hasOwn(landing, role)) throw new Error('Unknown role');
  (await cookies()).set(ROLE_COOKIE, role, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  revalidatePath('/', 'layout');
  redirect(safePath(next) ?? landing[role]);
}

export async function signOut() {
  (await cookies()).delete(ROLE_COOKIE);
  revalidatePath('/', 'layout');
  redirect(isMock ? '/demo' : '/login');
}

export async function advanceClock(days: number) {
  return attempt(async () => {
    const demo = (await getData()).demo;
    if (!demo) throw new Error('Demo controls exist only with mock data');
    const state = await demo.advance(Math.max(1, Math.min(60, Math.round(days))));
    revalidatePath('/', 'layout');
    return state;
  });
}

export async function resetDemo() {
  return attempt(async () => {
    const demo = (await getData()).demo;
    if (!demo) throw new Error('Demo controls exist only with mock data');
    const state = await demo.reset();
    revalidatePath('/', 'layout');
    return state;
  });
}
