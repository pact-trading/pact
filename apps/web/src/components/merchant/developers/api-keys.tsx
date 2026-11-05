'use client';

import { IconKey, IconPlus } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ApiKey } from '@pactagent/core/platform-types';
import { createApiKey, revokeApiKey } from '@/server/actions/merchant';
import { date } from '@/lib/format';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardHeader } from '../../ui/card';
import { CopyButton } from '../../ui/copy-button';
import { Dialog } from '../../ui/dialog';
import { Field, Input, Select } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { Table, Td, Th, Tr } from '../../ui/table';
import { useToast } from '../../ui/toast';

export function ApiKeys({ keys, readOnly }: { keys: ApiKey[]; readOnly: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ApiKey['kind']>('secret');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const close = () => {
    setOpen(false);
    setSecret(null);
    setName('');
    setError('');
  };
  return (
    <Card>
      <CardHeader
        title="API keys"
        description="Publishable keys are safe in the browser. Secret keys stay on your server and are shown once."
        action={
          !readOnly && (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <IconPlus className="size-4" />
              New key
            </Button>
          )
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Key</Th>
            <Th>Created</Th>
            <Th>Last used</Th>
            <Th align="right" />
          </tr>
        </thead>
        <tbody>
          {keys.map(key => (
            <Tr key={key.id} className={key.revokedAt ? 'opacity-60' : undefined}>
              <Td>
                <p className="font-medium">{key.name}</p>
                <Badge tone={key.kind === 'secret' ? 'neutral' : 'outline'}>{key.kind}</Badge>
              </Td>
              <Td>
                <code className="text-[13px]">{key.preview}</code>
              </Td>
              <Td className="text-muted-foreground">{date(key.createdAt)}</Td>
              <Td className="text-muted-foreground">
                {key.revokedAt
                  ? `Revoked ${date(key.revokedAt)}`
                  : key.lastUsedAt
                    ? date(key.lastUsedAt)
                    : 'Never'}
              </Td>
              <Td align="right">
                {!readOnly && !key.revokedAt && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const result = await revokeApiKey(key.id);
                        toast(
                          result.ok ? `${key.name} revoked` : result.error.message,
                          result.ok ? 'success' : 'danger',
                        );
                        router.refresh();
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <Dialog
        open={open}
        onClose={close}
        title={secret ? 'Copy your key now' : 'New API key'}
        description={secret ? 'This is the only time the full key is shown.' : undefined}
        footer={
          secret ? (
            <Button variant="dark" onClick={close}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="dark"
                disabled={pending || !name.trim()}
                onClick={() =>
                  start(async () => {
                    setError('');
                    const result = await createApiKey({ name, kind });
                    if (!result.ok) return setError(result.error.message);
                    setSecret(result.data.secret);
                    router.refresh();
                  })
                }
              >
                Create key
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <div className="grid gap-3">
            <div className="flex min-w-0 items-center gap-2 rounded-[14px] border border-input bg-raised py-1 pr-1 pl-3.5">
              <IconKey className="size-4 shrink-0 text-muted-foreground" />
              <code className="min-w-0 flex-1 text-sm break-all">{secret}</code>
              <CopyButton value={secret} label="Copy key" />
            </div>
            <Notice tone="warning">
              Store it in your server’s environment. Never put a secret key in browser code.
            </Notice>
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="Name">
              {id => (
                <Input
                  id={id}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Production server"
                />
              )}
            </Field>
            <Field label="Type">
              {id => (
                <Select id={id} value={kind} onChange={e => setKind(e.target.value as ApiKey['kind'])}>
                  <option value="secret">Secret, for your server</option>
                  <option value="publishable">Publishable, for the checkout widget</option>
                </Select>
              )}
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
          </div>
        )}
      </Dialog>
    </Card>
  );
}
