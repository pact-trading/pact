'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { NOTIFICATION_LABELS } from '@/lib/notifications';
import { connectCustomerTelegram, disconnectCustomerTelegram, updateCustomerNotifications } from '@/server/actions/customer';
import { connectMerchantTelegram, disconnectMerchantTelegram, updateMerchantNotifications } from '@/server/actions/merchant';
import type { NotificationPreferences } from '@/server/data/types';
import { Button } from '../ui/button';
import { Card, CardBody, CardHeader } from '../ui/card';
import { Field, Input } from '../ui/field';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';

/** Which events reach someone by email. Merchants choose the address; customers use their account's. */
export function NotificationPreferencesCard({
  kind,
  initial,
  readOnly,
  className,
}: {
  kind: 'merchant' | 'customer';
  initial: NotificationPreferences;
  readOnly?: boolean;
  className?: string;
}) {
  const toast = useToast();
  const [email, setEmail] = useState(initial.email ?? '');
  const router = useRouter();
  const telegram = initial.telegram;
  const [events, setEvents] = useState(initial.events);
  const [telegramEvents, setTelegramEvents] = useState(telegram?.events ?? []);
  const [telegramLink, setTelegramLink] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError('');
      const sentTelegram = telegram?.connected ? { telegramEvents } : {};
      const result =
        kind === 'merchant'
          ? await updateMerchantNotifications({ email: email.trim() || null, events, ...sentTelegram })
          : await updateCustomerNotifications({ events, ...sentTelegram });
      if (!result.ok) return setError(result.error.message);
      setEvents(result.data.events);
      toast('Notifications saved');
    });
  const connect = () =>
    start(async () => {
      setError('');
      const result = kind === 'merchant' ? await connectMerchantTelegram() : await connectCustomerTelegram();
      if (!result.ok) return setError(result.error.message);
      setTelegramLink(result.data.url);
    });
  const disconnect = () =>
    start(async () => {
      setError('');
      const result = kind === 'merchant' ? await disconnectMerchantTelegram() : await disconnectCustomerTelegram();
      if (!result.ok) return setError(result.error.message);
      toast('Telegram disconnected');
      router.refresh();
    });
  return (
    <Card className={className}>
      <CardHeader title="Notifications" description={telegram ? 'Choose which events reach you by email and by Telegram.' : 'Choose which events reach you by email.'} />
      <CardBody>
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            save();
          }}
        >
          <fieldset disabled={readOnly} className="contents">
            {kind === 'merchant' ? (
              <Field label="Send to" hint="Leave this empty to get no email.">
                {id => (
                  <Input
                    id={id}
                    type="email"
                    autoComplete="email"
                    value={email}
                    placeholder="you@example.com"
                    onChange={event => setEmail(event.target.value)}
                  />
                )}
              </Field>
            ) : initial.email ? (
              <p className="text-sm text-muted-foreground">Sent to {initial.email}.</p>
            ) : (
              <Notice tone="info">Your account has no email address, so we cannot email you.</Notice>
            )}
            <div className="grid gap-2">
              {initial.available.map(event => (
                <label key={event} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--pact-ink)]"
                    checked={events.includes(event)}
                    onChange={change =>
                      setEvents(current =>
                        change.target.checked ? [...current, event] : current.filter(item => item !== event),
                      )
                    }
                  />
                  {NOTIFICATION_LABELS[event]?.[kind] ?? event}
                </label>
              ))}
            </div>
            {telegram && (
              <div className="grid gap-3 border-t border-border pt-4">
                <p className="text-sm font-medium">Telegram</p>
                {telegram.connected ? (
                  <>
                    <div className="grid gap-2">
                      {initial.available.map(event => (
                        <label key={event} className="flex items-center gap-3 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--pact-ink)]"
                            checked={telegramEvents.includes(event)}
                            onChange={change =>
                              setTelegramEvents(current =>
                                change.target.checked ? [...current, event] : current.filter(item => item !== event),
                              )
                            }
                          />
                          {NOTIFICATION_LABELS[event]?.[kind] ?? event}
                        </label>
                      ))}
                    </div>
                    {!readOnly && (
                      <div>
                        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={disconnect}>
                          Disconnect Telegram
                        </Button>
                      </div>
                    )}
                  </>
                ) : telegramLink ? (
                  <div className="grid gap-2 text-sm">
                    <a href={telegramLink} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
                      Open the Pact bot
                    </a>
                    <p className="text-[13px] text-muted-foreground">
                      Press Start in Telegram. This link works once and lasts 15 minutes.
                    </p>
                    <div>
                      <Button type="button" variant="secondary" size="sm" onClick={() => router.refresh()}>
                        I pressed Start
                      </Button>
                    </div>
                  </div>
                ) : (
                  !readOnly && (
                    <div>
                      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={connect}>
                        Connect Telegram
                      </Button>
                    </div>
                  )
                )}
              </div>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
            {!readOnly && (
              <div>
                <Button type="submit" variant="dark" disabled={pending}>
                  {pending ? 'Saving…' : 'Save notifications'}
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      </CardBody>
    </Card>
  );
}
