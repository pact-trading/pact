/**
 * The middle of the landing, between the hero and the closing CTA. It is Polar's landing
 * (github.com/polarsource/polar, Apache-2.0), ported in ../polar: hairline chapters with a
 * marker and a two-tone headline, figure windows over dimmed backdrops, graphic cards, the
 * cornered contents grid and the text rings. The figures are screenshots of the real merchant
 * app (apps/web in demo mode, dark theme); the light-rail look stays in the card-free graphics.
 */
import { useState, type CSSProperties } from 'react';
import {
  IconFileInvoice,
  IconLink,
  IconLock,
  IconReceiptRefund,
  IconReceiptTax,
  IconRepeat,
  IconRobot,
  IconShoppingCart,
  IconUserCircle,
  IconWebhook,
} from '@tabler/icons-react';
import { cn } from '@web/lib/cn';
import { APP_URL, DOCS_URL } from '@/links';
import { Chapter, Column, Corners, GraphicCardGrid, PillButton, Screen } from '../polar/Layout';
import { GaugeSweep } from '../polar/graphics/GaugeSweep';
import { RadialSpinner } from '../polar/graphics/RadialSpinner';
import { SteppedRadial } from '../polar/graphics/SteppedRadial';
import { TextRings } from '../polar/graphics/TextRings';
import './pay.css';

/* ---------- Line art for the Pay, Check, Settle cards (lime light running on the strokes) ---------- */

function Wire({ d, delay = 0 }: { d: string; delay?: number }) {
  return (
    <>
      <path d={d} className="ill-wire" />
      <path d={d} pathLength={100} className="ill-light" style={{ animationDelay: `${delay}s` }} />
    </>
  );
}

function PayArt() {
  return (
    <svg viewBox="0 0 320 140" className="ill" aria-hidden>
      <Wire d="M42 22 H70 C100 22 100 56 128 62" />
      <Wire d="M42 70 H128" delay={0.5} />
      <Wire d="M42 118 H70 C100 118 100 84 128 78" delay={1} />
      <Wire d="M192 70 H262" delay={1.5} />
      {[22, 70, 118].map(y => (
        <rect key={y} x="22" y={y - 10} width="20" height="20" rx="5" className="ill-node" />
      ))}
      <path d="M160 26 L194 38 V70 C194 94 178 108 160 116 C142 108 126 94 126 70 V38 Z" className="ill-core" />
      <path d="M145 70 L156 81 L177 58" className="ill-mark" />
      <rect x="262" y="52" width="36" height="36" rx="9" className="ill-node ill-glow" />
    </svg>
  );
}

function CheckArt() {
  return (
    <svg viewBox="0 0 320 140" className="ill" aria-hidden>
      <Wire d="M52 70 H128" />
      <Wire d="M192 70 H214 C232 70 230 30 252 30 H268" delay={0.8} />
      <Wire d="M192 70 H214 C232 70 230 110 252 110 H268" delay={1.2} />
      <circle cx="38" cy="70" r="14" className="ill-node ill-glow" />
      <rect x="128" y="36" width="64" height="68" rx="14" className="ill-core" />
      <path d="M148 66 V58 C148 44 172 44 172 58 V66" className="ill-mark" />
      <rect x="144" y="66" width="32" height="24" rx="4" className="ill-mark" />
      <rect x="268" y="20" width="20" height="20" rx="5" className="ill-node" />
      <rect x="268" y="100" width="20" height="20" rx="5" className="ill-node" />
    </svg>
  );
}

function SettleArt() {
  return (
    <svg viewBox="0 0 320 140" className="ill" aria-hidden>
      <Wire d="M44 70 H110" />
      <Wire d="M226 70 H272" delay={1.4} />
      <circle cx="32" cy="70" r="11" className="ill-node" />
      <circle cx="74" cy="70" r="3" className="ill-dot" />
      <rect x="110" y="16" width="116" height="108" rx="14" className="ill-core" />
      <path d="M128 44 L134 50 L144 40 M156 46 H206" className="ill-mark ill-tick" style={{ animationDelay: '0.4s' }} />
      <path d="M128 72 L134 78 L144 68 M156 74 H206" className="ill-mark ill-tick" style={{ animationDelay: '0.9s' }} />
      <path d="M128 102 H140 M156 102 H206" className="ill-mark ill-tick" style={{ animationDelay: '1.4s' }} />
      <rect x="272" y="60" width="20" height="20" rx="5" className="ill-node ill-glow" />
    </svg>
  );
}

/* ---------- Contents grid ---------- */

const features = [
  ['Payment links', IconLink],
  ['Checkout', IconShoppingCart],
  ['Invoices', IconFileInvoice],
  ['Subscriptions', IconRepeat],
  ['Signed caps', IconLock],
  ['Refunds', IconReceiptRefund],
  ['Webhooks', IconWebhook],
  ['Agent payments', IconRobot],
  ['One fee', IconReceiptTax],
  ['Customer portal', IconUserCircle],
] as const;

/** Polar's contents grid: square tiles with corner marks; hovering one dims the rest. */
function Contents() {
  return (
    <nav aria-label="Features" className="grid grid-cols-2 gap-4 lg:grid-cols-5 [&:has(>:hover)>:not(:hover)]:opacity-40">
      {features.map(([name, Icon], i) => (
        <a
          key={name}
          href={DOCS_URL}
          className="pl-tile group relative flex aspect-square flex-col justify-between overflow-hidden border border-[#2a2a2a] bg-cover bg-center p-5 text-left no-underline transition-opacity duration-150"
          style={{ '--i': i, backgroundImage: `url('/landing/tiles/tile-${String(i + 1).padStart(2, '0')}.webp')` } as CSSProperties}
        >
          <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.35),rgba(0,0,0,0.1)_45%,rgba(0,0,0,0.6))] transition-opacity duration-300 group-hover:opacity-50" />
          <Corners />
          <span className="relative font-mono text-[13px] text-white/70">{String(i + 1).padStart(2, '0')}</span>
          <Icon stroke={1} className="pl-tile-icon relative mx-auto size-[38%] text-white/90 drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)] transition-colors group-hover:text-primary" />
          <span className="relative text-[17px] font-medium tracking-[-0.01em] text-white">{name}</span>
        </a>
      ))}
    </nav>
  );
}

/* ---------- The page ---------- */

const faqs = [
  ['Do my customers need a wallet?', 'No. They sign in with an email or a passkey and pay. They never pay a fee or gas.'],
  ['Which chain and token?', 'USDT on Whitechain. Today Pact runs on the Whitechain testnet.'],
  ['How are subscriptions kept safe?', 'The customer signs a price cap and a period once. The contract refuses any renewal above the cap or too early.'],
  ['What does Pact cost?', 'One fee, taken from each payment: 0.8% of a checkout payment, at least 0.15 USDT, and 0.5% of an invoice, at most 10 USDT. You sign the terms once. There is no gas to buy: Pact pays it, and nobody holds WBT.'],
  ['Can I refund a payment?', 'Yes. Full or partial, in one click. The refund is public on the explorer.'],
  ['How do agents pay?', 'Put an x402 price on an API route. Agents pay per call in USDT, within the caps their owner sets.'],
];

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <div className="divide-y divide-white/[0.09] border-y border-white/[0.09]">
      {faqs.map(([q, a], i) => (
        <div key={q}>
          <button
            type="button"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? -1 : i)}
            className="flex w-full items-center justify-between gap-6 py-5 text-left text-[18px] text-foreground"
          >
            {q}
            <span className={cn('text-xl text-muted-foreground transition-transform', open === i && 'rotate-45')}>+</span>
          </button>
          {open === i && <p className="-mt-1 pb-5 text-[16px] leading-normal text-muted-foreground">{a}</p>}
        </div>
      ))}
    </div>
  );
}

export function PolarSections() {
  return (
    <Column>
      <Chapter
        id="checkout"
        name="01 Checkout"
        title="Every customer can pay"
        subtitle="with an email, no wallet and no gas"
        description="Share a payment link, embed checkout or send an invoice. Customers sign in with an email or a passkey and pay in USDT."
      >
        <Screen flow={1} src="/landing/app/checkout.webp" alt="Pact checkout: pay $490.00 with a Pact account" />
        <GraphicCardGrid
          cards={[
            { title: 'Customer pays', desc: 'An email sign-in and one confirmation. No wallet, no gas.', href: DOCS_URL, Graphic: PayArt },
            { title: 'Contract checks', desc: 'Caps, allowlist, replay and dust checks run onchain.', href: DOCS_URL, Graphic: CheckArt },
            { title: 'You get paid', desc: 'USDT settles in one block. Every refund and refusal is public.', href: DOCS_URL, Graphic: SettleArt },
          ]}
        />
      </Chapter>

      <Chapter
        id="subscriptions"
        name="02 Subscriptions"
        title="Renewals that can't overcharge"
        subtitle="the customer signs the cap once"
        description="Each subscription carries a price cap and a period the customer signed. The contract refuses any renewal above the cap or too early."
      >
        <Screen flow={2} src="/landing/app/subscriptions.webp" alt="Subscriptions in the Pact dashboard: plans with signed caps and subscribers" />
      </Chapter>

      <Chapter
        id="how"
        name="03 Settle"
        title="Paid in one block"
        subtitle="with every step on the record"
        description="Every payment goes through Pact's router on Whitechain. Checks run onchain, USDT settles in one block, and a signed webhook follows."
      >
        <Screen flow={3} src="/landing/app/order.webp" alt="An order in the Pact dashboard: receipt, fee, net and onchain timeline" />
      </Chapter>

      <Chapter
        id="agents"
        name="04 Agents"
        title="Let agents pay per call"
        subtitle="with an x402 price on any route"
        description="Put a price on an API route. Agents pay per call in USDT, within the caps their owner sets, and you can pause any of them."
      >
        <Screen flow={4} src="/landing/app/agents.webp" alt="Agents paying over x402, each within its owner's caps" />
      </Chapter>

      <Chapter
        id="fees"
        name="05 Fees"
        title="One fee, from the payment"
        subtitle="and no gas for anyone"
        description="Pact takes 0.8% of each checkout payment, at least 0.15 USDT, and 0.5% of each invoice, at most 10 USDT, out of the payment itself. You sign the terms once. Pact pays the gas, so neither you nor your customers ever hold WBT."
      >
        <GraphicCardGrid
          cards={[
            { title: 'Paid net', desc: 'A 100 USDT checkout payment reaches you as 99.20 USDT, in the same block.', Graphic: GaugeSweep },
            { title: 'Only you spend your money', desc: 'A refund runs only when you sign it. Anyone else’s call is refused before it is sent.', Graphic: RadialSpinner },
            { title: 'Dust refused', desc: 'Payments under the minimum never reach the chain.', Graphic: SteppedRadial },
          ]}
        />
      </Chapter>

      <Chapter
        name="Everything in Pact"
        nameNote="On Whitechain"
        title="One app for getting paid"
        subtitle="from the first link to the last refund"
        description="One merchant app, one router contract, and SDKs for React, Node and Expo."
        cta={
          <>
            <PillButton href={APP_URL}>Start selling ›</PillButton>
            <PillButton href={DOCS_URL} ghost>
              Read the docs
            </PillButton>
          </>
        }
      >
        <Contents />
      </Chapter>

      <Chapter
        id="integrations"
        name="Integrate"
        title="A few lines of code"
        subtitle="then you get paid"
        description="Drop checkout into React, a Node server or an Expo app. Test on Whitechain Sepolia first."
      >
        <Screen flow={6} src="/landing/app/developers.webp" alt="The integration page: React widget, SDK, payment links, keys and webhooks" />
      </Chapter>

      <Chapter id="faq" name="Questions" title="Before you start" subtitle="the short answers">
        <div className="grid lg:grid-cols-2 lg:gap-4">
          <div className="hidden lg:block" />
          <Faq />
        </div>
      </Chapter>

      <section className="flex w-full flex-col items-center border-t border-white/[0.09] py-16 md:my-8 md:py-24">
        <div className="pl-rings block w-full max-w-[70%]">
          <TextRings />
        </div>
      </section>
    </Column>
  );
}
