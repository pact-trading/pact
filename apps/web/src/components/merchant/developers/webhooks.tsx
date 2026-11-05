'use client';

import { IconClockPlus, IconFileSearch, IconRefresh, IconSend, IconWebhook } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { WebhookDelivery, WebhookEvent } from '@pactagent/core/api-types';
import type { WebhookConfig } from '@pactagent/core/platform-types';
import type { WebhookOutcome, WebhookReceipt } from '@/server/data/parts/lab';
import { queueTestEvent, simulateWebhook } from '@/server/actions/lab';
import { configureWebhook, replayWebhook, sendTestWebhook } from '@/server/actions/merchant';
import { dateTime, time } from '@/lib/format';
import { Badge, StatusBadge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardBody, CardHeader } from '../../ui/card';
import { CodeBlock } from '../../ui/code-block';
import { CopyButton } from '../../ui/copy-button';
import { Dialog } from '../../ui/dialog';
import { EmptyState } from '../../ui/empty-state';
import { Field, Input } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { Table, Td, Th, Tr } from '../../ui/table';
import { useToast } from '../../ui/toast';

type Result = { ok: true } | { ok: false; error: { message: string } };

export function Webhooks({
  config,
  events,
  deliveries,
  readOnly,
  lab = null,
}: {
  config: WebhookConfig;
  events: WebhookEvent[];
  deliveries: WebhookDelivery[];
  readOnly: boolean;
  /** Mock mode only: simulated endpoint answers and what the demo store did with each event. */
  lab?: { receipts: WebhookReceipt[] } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [url, setUrl] = useState(config.url ?? '');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (work: () => Promise<Result>, message: string) =>
    start(async () => {
      const result = await work();
      toast(result.ok ? message : result.error.message, result.ok ? 'success' : 'danger');
      router.refresh();
    });
  const attempts = (eventId: string) => deliveries.filter(d => d.event_id === eventId);
  const event = events.find(e => e.id === selected) ?? null;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader
          title="Endpoint"
          description="Signed with HMAC, retried with backoff for up to a day, replayable from here."
        />
        <CardBody className="grid gap-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={submit => {
              submit.preventDefault();
              start(async () => {
                setError('');
                const result = await configureWebhook(url);
                if (!result.ok) return setError(result.error.message);
                setSecret(result.data.signingSecret);
                toast('Endpoint saved and secret rotated');
                router.refresh();
              });
            }}
          >
            <Field label="URL" className="min-w-0 flex-1 basis-64">
              {id => (
                <Input
                  id={id}
                  type="url"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://api.example.com/webhooks/pact"
                  disabled={readOnly}
                />
              )}
            </Field>
            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="dark" disabled={pending}>
                  Save and rotate secret
                </Button>
                <Button
                  disabled={pending || !config.configured}
                  onClick={() => run(sendTestWebhook, 'Test event sent')}
                >
                  <IconSend className="size-4" />
                  Send test
                </Button>
                {lab && (
                  <Button
                    disabled={pending || !config.configured}
                    onClick={() => run(queueTestEvent, 'Test event queued. Open it to answer it.')}
                  >
                    <IconClockPlus className="size-4" />
                    Queue test event
                  </Button>
                )}
              </div>
            )}
          </form>
          {secret && (
            <Notice
              tone="warning"
              title="New signing secret, shown once"
              action={<CopyButton value={secret} label="Copy secret" showLabel />}
            >
              <code className="break-all">{secret}</code>
            </Notice>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          {config.secretPreview && (
            <p className="text-[13px] text-muted-foreground">
              Signing secret <code className="font-mono">{config.secretPreview}</code>, sent as the{' '}
              <code className="font-mono">x-settle-signature</code> header.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {config.eventTypes.map(type => (
              <Badge key={type} tone="outline" className="font-mono">
                {type}
              </Badge>
            ))}
          </div>
          {lab && !readOnly && (
            <Notice tone="info" title="Demo: simulate your endpoint">
              Queue a test event, or buy on the demo store, then open the event to answer it with a delivery,
              a failure, a retry or a duplicate. Nothing leaves the sandbox.
            </Notice>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Recent events"
          description="Deduplicate by event id; a retry reuses the same id with a higher attempt"
        />
        {events.length === 0 ? (
          <EmptyState icon={<IconWebhook />} title="No events yet">
            Payments, refunds, invoices and renewals each create an event here.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Object</Th>
                <Th>Time</Th>
                <Th>Delivery</Th>
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 25).map(item => {
                const delivery = attempts(item.id)[0];
                return (
                  <Tr key={item.id}>
                    <Td>
                      <code className="text-[13px] font-semibold">{item.type}</code>
                      <p className="font-mono text-[12px] text-muted-foreground">{item.id}</p>
                    </Td>
                    <Td className="max-w-[180px] truncate font-mono text-[12px] text-muted-foreground">
                      {item.object_id}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{dateTime(item.created_at)}</Td>
                    <Td>{delivery ? <DeliveryState delivery={delivery} /> : <NoEndpoint />}</Td>
                    <Td align="right" className="whitespace-nowrap">
                      {lab && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Details for ${item.id}`}
                          onClick={() => setSelected(item.id)}
                        >
                          <IconFileSearch className="size-4" />
                          Details
                        </Button>
                      )}
                      {!readOnly && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => run(() => replayWebhook(item.id), 'Replay queued')}
                        >
                          <IconRefresh className="size-4" />
                          Replay
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {lab && (
        <EventDialog
          event={event}
          attempts={event ? attempts(event.id) : []}
          receipt={event ? (lab.receipts.find(r => r.eventId === event.id) ?? null) : null}
          readOnly={readOnly}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

const NoEndpoint = () => <span className="text-[13px] text-muted-foreground">No endpoint</span>;

function DeliveryState({ delivery }: { delivery: WebhookDelivery }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge status={delivery.status} />
      <span className="text-[13px] text-muted-foreground">
        attempt {delivery.attempt}
        {delivery.last_http_status ? ` · ${delivery.last_http_status}` : ''}
        {delivery.status === 'pending' && ` · due ${time(delivery.next_at)}`}
        {delivery.status === 'failed' && ` · retry ${time(delivery.next_at)}`}
      </span>
    </span>
  );
}

/** One event: its payload, every attempt, and (in the demo) the simulated endpoint answers. */
function EventDialog({
  event,
  attempts,
  receipt,
  readOnly,
  onClose,
}: {
  event: WebhookEvent | null;
  attempts: WebhookDelivery[];
  receipt: WebhookReceipt | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const latest = attempts[0];
  const close = () => {
    setMessage(null);
    onClose();
  };
  const simulate = (outcome: WebhookOutcome) =>
    start(async () => {
      if (!event) return;
      const result = await simulateWebhook(event.id, outcome);
      setMessage(
        result.ok
          ? { tone: 'success', text: result.data.message }
          : { tone: 'danger', text: result.error.message },
      );
      router.refresh();
    });
  return (
    <Dialog
      open={event !== null}
      onClose={close}
      title={event ? <code className="font-mono">{event.type}</code> : ''}
      description={event ? `${event.id} · ${dateTime(event.created_at)}` : undefined}
      className="sm:max-w-xl"
      footer={
        <Button variant="dark" onClick={close}>
          Close
        </Button>
      }
    >
      {event && (
        <div className="grid gap-4">
          <CodeBlock
            title="Payload"
            code={JSON.stringify(
              { id: event.id, type: event.type, object_id: event.object_id, created_at: event.created_at },
              null,
              2,
            )}
          />
          <section aria-label="Delivery attempts">
            <h3 className="mb-2 text-sm font-semibold">Attempts</h3>
            {attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Never sent: there was no endpoint when this happened.
              </p>
            ) : (
              <ol className="divide-y divide-border-subtle rounded-xl border border-border">
                {attempts.map(d => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <span className="text-sm font-medium">Attempt {d.attempt}</span>
                    <DeliveryState delivery={d} />
                  </li>
                ))}
              </ol>
            )}
          </section>
          {receipt && (
            <Notice tone="success" title="The demo store fulfilled this order once">
              Order <code className="font-mono">{receipt.orderId}</code>
              {receipt.duplicatesIgnored > 0
                ? `; ${receipt.duplicatesIgnored} duplicate deliver${receipt.duplicatesIgnored === 1 ? 'y' : 'ies'} ignored by event id.`
                : '.'}
            </Notice>
          )}
          {!readOnly && latest && (
            <section aria-label="Simulate the endpoint" className="grid gap-2">
              <h3 className="text-sm font-semibold">
                Simulate your endpoint <Badge tone="outline">Demo</Badge>
              </h3>
              <div className="flex flex-wrap gap-2">
                {latest.status === 'pending' && (
                  <>
                    <Button size="sm" variant="dark" disabled={pending} onClick={() => simulate('delivered')}>
                      Deliver (200)
                    </Button>
                    <Button size="sm" disabled={pending} onClick={() => simulate('failed')}>
                      Fail (503)
                    </Button>
                  </>
                )}
                {latest.status === 'failed' && (
                  <>
                    <Button size="sm" variant="dark" disabled={pending} onClick={() => simulate('retry')}>
                      Retry now
                    </Button>
                    <Button size="sm" disabled={pending} onClick={() => simulate('failed')}>
                      Fail again
                    </Button>
                  </>
                )}
                {latest.status === 'delivered' && (
                  <Button size="sm" disabled={pending} onClick={() => simulate('duplicate')}>
                    Send duplicate
                  </Button>
                )}
              </div>
              {latest.status === 'delivered' && (
                <p className="text-[13px] text-muted-foreground">
                  Delivered events stay delivered: a later failure cannot undo them.
                </p>
              )}
            </section>
          )}
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
        </div>
      )}
    </Dialog>
  );
}
