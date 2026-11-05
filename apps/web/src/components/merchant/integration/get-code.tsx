'use client';

import Link from 'next/link';
import { IconBook, IconCode } from '@tabler/icons-react';
import { useState } from 'react';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { CodeTabs } from './code-tabs';
import type { SnippetContext } from './snippets';

/** The "Get code" dialog: one checkout in four stacks. */
export function GetCode({ context }: { context: SnippetContext }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <IconCode className="size-4.5" />
        Get code
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Get code"
        description="A checkout for the same order in your stack. The secret key stays on your server."
        className="sm:max-w-2xl"
        footer={
          <>
            <Button asChild variant="ghost">
              <Link href="/docs">
                <IconBook className="size-4.5" />
                Quickstart
              </Link>
            </Button>
            <Button variant="dark" onClick={() => setOpen(false)}>
              Done
            </Button>
          </>
        }
      >
        <CodeTabs context={context} />
      </Dialog>
    </>
  );
}
