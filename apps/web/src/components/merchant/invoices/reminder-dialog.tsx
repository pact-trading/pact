'use client';

import { IconBell, IconClockPause } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ManualReminder } from '@/server/data/types';
import { cancelReminder, sendReminder } from '@/server/actions/merchant';
import { dateTime } from '@/lib/format';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Field, Input, Textarea } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';
import { RadioCards } from '../../portal/radio-cards';

const DAY = 86_400_000;

/** The demo clock's next day at 09:00 UTC, as date and time input values. */
function tomorrowMorning(now: string) {
  const next = new Date(new Date(now).getTime() + DAY);
  return { date: next.toISOString().slice(0, 10), time: '09:00' };
}

/** Send a written reminder now, or schedule it. The keeper sends scheduled ones on time. */
export function ReminderDialog({
  invoiceId,
  to,
  defaultMessage,
  now,
}: {
  invoiceId: string;
  to: string;
  defaultMessage: string;
  now: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [message, setMessage] = useState(defaultMessage);
  const [when, setWhen] = useState(() => tomorrowMorning(now));
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);
  const [pending, start] = useTransition();

  const sendAt = mode === 'later' ? new Date(`${when.date}T${when.time || '00:00'}:00Z`) : null;
  const timeError =
    mode !== 'later'
      ? ''
      : !when.date || !when.time || Number.isNaN(sendAt!.getTime())
        ? 'Choose a date and time.'
        : sendAt!.getTime() <= new Date(now).getTime()
          ? 'Choose a time after now, or send it now.'
          : '';
  const messageError = message.trim() ? '' : 'Write a message for the payer.';

  const close = () => {
    setOpen(false);
    setError('');
    setTried(false);
  };
  const submit = () =>
    start(async () => {
      setTried(true);
      setError('');
      if (timeError || messageError) return;
      const result = await sendReminder(invoiceId, {
        message,
        sendAt: sendAt ? sendAt.toISOString() : null,
      });
      if (!result.ok) return setError(result.error.message);
      toast(
        result.data.sentAt
          ? `Reminder sent to ${result.data.to}`
          : `Reminder scheduled for ${dateTime(result.data.sendAt)}`,
      );
      close();
      router.refresh();
    });

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setMode('now');
          setMessage(defaultMessage);
          setWhen(tomorrowMorning(now));
          setOpen(true);
        }}
      >
        <IconBell className="size-4" />
        Send reminder
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Send reminder"
        description={`To ${to}. Reminders go by email when a mail key is set, otherwise to the dashboard and a webhook.`}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="dark" onClick={submit} disabled={pending}>
              {pending ? 'Saving…' : mode === 'now' ? 'Send reminder' : 'Schedule reminder'}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <RadioCards
            legend="When"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'now', title: 'Send now' },
              { value: 'later', title: 'Schedule', body: 'Pick a date and time in UTC' },
            ]}
          />
          {mode === 'later' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date (UTC)" error={tried && timeError ? timeError : undefined}>
                {id => (
                  <Input
                    id={id}
                    type="date"
                    value={when.date}
                    aria-invalid={tried && Boolean(timeError)}
                    onChange={e => setWhen(w => ({ ...w, date: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Time (UTC)">
                {id => (
                  <Input
                    id={id}
                    type="time"
                    value={when.time}
                    aria-invalid={tried && Boolean(timeError)}
                    onChange={e => setWhen(w => ({ ...w, time: e.target.value }))}
                  />
                )}
              </Field>
            </div>
          )}
          <Field label="Message" error={tried && messageError ? messageError : undefined}>
            {id => (
              <Textarea
                id={id}
                value={message}
                maxLength={1000}
                aria-invalid={tried && Boolean(messageError)}
                onChange={e => setMessage(e.target.value)}
              />
            )}
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
        </form>
      </Dialog>
    </>
  );
}

/** Written reminders on the invoice page: sent ones, and scheduled ones that can be called off. */
export function ManualReminderList({
  invoiceId,
  reminders,
  readOnly,
}: {
  invoiceId: string;
  reminders: ManualReminder[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  if (!reminders.length) return null;
  return (
    <ul className="grid gap-2 border-t border-border-subtle pt-3">
      {reminders.map(r => (
        <li key={r.id} className="grid gap-1 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {r.sentAt
                ? `Sent ${dateTime(r.sentAt)}`
                : r.cancelledAt
                  ? 'Called off'
                  : `Scheduled for ${dateTime(r.sendAt)}`}
            </span>
            {!r.sentAt && !r.cancelledAt && !readOnly && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await cancelReminder(invoiceId, r.id);
                    if (!result.ok) toast(result.error.message, 'danger');
                    else toast('Scheduled reminder called off');
                    router.refresh();
                  })
                }
              >
                <IconClockPause className="size-4" />
                Call off
              </Button>
            )}
          </div>
          <p className="line-clamp-2 text-[13px] text-muted-foreground">{r.message}</p>
        </li>
      ))}
    </ul>
  );
}
