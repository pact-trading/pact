import Link from 'next/link';
import type { ReactNode } from 'react';
import { PactLogo } from '../brand/pact-logo';
import { ThemeToggle } from '../shell/theme-toggle';

export interface LegalSection {
  title: string;
  body: ReactNode[];
}

const pages = [
  { href: '/legal/terms', label: 'Terms' },
  { href: '/legal/privacy', label: 'Privacy' },
];

/** Plain reading layout for the Terms and Privacy pages the checkout footer links to. */
export function LegalPage({
  current,
  title,
  updated,
  intro,
  sections,
}: {
  current: '/legal/terms' | '/legal/privacy';
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  const other = pages.find(page => page.href !== current)!;
  return (
    <div className="min-h-[calc(100dvh-2.5rem)] [.no-demo_&]:min-h-dvh">
      <header className="border-b border-border bg-nav backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-5">
          <Link href="/" aria-label="Pact home" className="rounded-md">
            <PactLogo width={84} />
          </Link>
          <nav aria-label="Legal" className="ml-auto flex items-center gap-1">
            {pages.map(page => (
              <Link
                key={page.href}
                href={page.href}
                aria-current={page.href === current ? 'page' : undefined}
                className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-chip hover:text-foreground aria-[current=page]:bg-chip aria-[current=page]:font-medium aria-[current=page]:text-foreground"
              >
                {page.label}
              </Link>
            ))}
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className="mx-auto grid max-w-3xl gap-10 px-5 py-12 sm:py-16">
        <div className="grid gap-3">
          <p className="text-sm font-medium text-muted-foreground">Pact Pay · hackathon demo</p>
          <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">Last updated {updated}</p>
          <div className="text-[17px] leading-7 text-subtle-foreground">{intro}</div>
        </div>
        <nav aria-label="On this page" className="rounded-2xl border border-border bg-card p-5 shadow-panel">
          <p className="mb-3 text-sm font-semibold">On this page</p>
          <ol className="grid gap-2 text-sm sm:grid-cols-2">
            {sections.map((section, index) => (
              <li key={section.title}>
                <a
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  href={`#section-${index + 1}`}
                >
                  {index + 1}. {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        {sections.map((section, index) => (
          <section key={section.title} id={`section-${index + 1}`} className="grid scroll-mt-16 gap-3">
            <h2 className="text-xl font-semibold">
              {index + 1}. {section.title}
            </h2>
            {section.body.map((paragraph, key) => (
              <p key={key} className="text-base leading-7 text-subtle-foreground">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
        <p className="border-t border-border pt-6 text-sm text-muted-foreground">
          See also the{' '}
          <Link className="font-medium text-foreground underline underline-offset-4" href={other.href}>
            {other.href === '/legal/terms' ? 'Terms of use' : 'Privacy notice'}
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
