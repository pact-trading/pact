// Adapted from Polar (https://github.com/polarsource/polar), Apache License 2.0.
// Ported from Polar's Orbit/StyleX primitives to Tailwind. Sizes follow Orbit's tokens:
// heading-s 24/30px, heading-xs 20/24px, heading-xxs 18/20px, body 16px, caption 12px;
// spacing xs 4, s 8, m 12, l 16, xl 24, 2xl 32, 3xl 48, 4xl 64, 5xl 96.
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { IconArrowRight } from '@tabler/icons-react';
import { PactLogo } from '@web/components/brand/pact-logo';
import { AppTheme } from '@/components/app-cards';

const headingS = 'text-[24px] md:text-[30px] leading-[1.375] font-normal tracking-normal';
const headingXs = 'text-[20px] md:text-[24px] leading-[1.375] font-normal';
const headingXxs = 'text-[18px] md:text-[20px] leading-[1.375] font-normal';

/** The chapter's name, with an optional muted line under it. A leading number is set muted ahead of it. */
function ChapterMarker({ name, note }: { name: string; note?: string }) {
  const [, number, label] = name.match(/^(\d+)\s+(.*)$/) ?? [null, null, name];
  return (
    <div className="hidden flex-col items-start md:flex">
      <div className={`${headingS} text-foreground`}>
        {number ? <span className="mr-4 text-muted-foreground">{number}</span> : null}
        {label}
      </div>
      {note ? <div className={`${headingS} text-muted-foreground`}>{note}</div> : null}
    </div>
  );
}

export function ChapterHeadline({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col">
      <h2 className={`${headingS} text-balance text-foreground`}>{title}</h2>
      <p className={`${headingS} text-balance text-muted-foreground`}>{subtitle}</p>
    </div>
  );
}

/**
 * A full-width narrative chapter: a hairline top border, a header row with the chapter marker on
 * the left and a two-tone headline plus description on the right, then the chapter's content.
 */
export function Chapter({
  id,
  name,
  nameNote,
  title,
  subtitle,
  description,
  cta,
  children,
}: {
  id?: string;
  name?: string;
  nameNote?: string;
  title: string;
  subtitle: string;
  description?: ReactNode;
  cta?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          node.dataset.in = '';
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return (
    <section
      ref={ref}
      id={id}
      className="pl-chapter flex w-full scroll-mt-24 flex-col gap-y-12 border-t border-white/[0.09] py-16 md:my-8 md:gap-y-24 md:py-24"
    >
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-4">
        {name ? <ChapterMarker name={name} note={nameNote} /> : <div className="hidden lg:flex" />}
        <div className="flex flex-col items-start gap-y-16">
          <ChapterHeadline title={title} subtitle={subtitle} />
          {description ? <p className={`${headingXs} text-pretty text-muted-foreground`}>{description}</p> : null}
          {cta ? <div className="flex items-center gap-x-4 pt-2">{cta}</div> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

/** The page column: Polar's max-w-7xl with side padding. */
export function Column({ children }: { children: ReactNode }) {
  return <div className="app-ui mx-auto flex w-full max-w-7xl flex-col px-5 md:px-8">{children}</div>;
}

/** Backdrop images, rendered from the hero's shader gradient, one style per chapter. */
const FLOW = {
  1: "bg-[url('/landing/flow-1.webp')]",
  2: "bg-[url('/landing/flow-2.webp')]",
  3: "bg-[url('/landing/flow-3.webp')]",
  4: "bg-[url('/landing/flow-4.webp')]",
  5: "bg-[url('/landing/flow-5.webp')]",
  6: "bg-[url('/landing/flow-6.webp')]",
} as const;
export type Flow = keyof typeof FLOW;

/** The window chrome: a dark frame with a hairline and a 4px inset, the logo and an aside on top. */
export function WindowFrame({ aside, children, narrow = false }: { aside?: ReactNode; children: ReactNode; narrow?: boolean }) {
  return (
    <div
      className={`theme-dark relative mx-auto flex w-full min-w-0 flex-col rounded-2xl border border-[#1f1f1f] bg-[#0a0a0a] p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.75)] ${narrow ? 'max-w-[56rem]' : ''}`}
    >
      <div className="flex items-center justify-between gap-x-4 px-6 py-3">
        <span className="text-foreground">
          <PactLogo width={58} />
        </span>
        {typeof aside === 'string' ? <span className="text-[12px] text-muted-foreground">{aside}</span> : aside}
      </div>
      <AppTheme.Provider value="dark">{children}</AppTheme.Provider>
    </div>
  );
}

/** A figure window: the dimmed backdrop image, the dark frame, and an aside. */
export function Window({ flow, aside, children, narrow }: { flow: Flow; aside?: string; children: ReactNode; narrow?: boolean }) {
  return (
    <div className={`pl-window relative w-full overflow-hidden rounded-md border border-[#1f1f1f] bg-cover bg-center p-4 md:p-12 ${FLOW[flow]}`}>
      <div className="pointer-events-none absolute inset-0 bg-black/20" />
      <WindowFrame aside={aside} narrow={narrow}>
        {children}
      </WindowFrame>
    </div>
  );
}

/** A screenshot of the real app over a backdrop image, as Polar frames its product shots. */
export function Screen({ flow, src, alt }: { flow: Flow; src: string; alt: string }) {
  return (
    <div className={`pl-window relative w-full overflow-hidden rounded-md border border-[#1f1f1f] bg-cover bg-center p-3 sm:p-6 md:p-12 ${FLOW[flow]}`}>
      <div className="pointer-events-none absolute inset-0 bg-black/20" />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#0a0a0a] shadow-[0_24px_60px_-16px_rgba(0,0,0,0.8)]">
        <img src={src} alt={alt} width={2880} height={1800} loading="lazy" decoding="async" className="block h-auto w-full" />
      </div>
    </div>
  );
}

/** Sheets inside a window, side by side with a 4px gap, as Polar lays its figures out. */
export function Sheets({ children }: { children: ReactNode }) {
  return <div className="pl-sheets grid gap-1 md:grid-cols-2">{children}</div>;
}

/** A graphic in a rounded panel, with a title, description and link beneath it. */
export function GraphicCard({ title, desc, href, Graphic }: { title: string; desc: string; href?: string; Graphic: ComponentType }) {
  return (
    <div className="pl-graphic flex flex-col gap-y-6">
      <div className="aspect-square w-full overflow-hidden rounded-md border border-[#1f1f1f] bg-[#111111] p-8 xl:p-12">
        <div className="flex h-full w-full items-center justify-center">
          <Graphic />
        </div>
      </div>
      <div className="flex flex-col gap-y-1">
        <h3 className={`${headingXxs} text-foreground`}>{title}</h3>
        <p className="text-[16px] leading-normal text-pretty text-muted-foreground">{desc}</p>
        {href ? (
          <a href={href} className="flex items-center gap-x-1 pt-2 text-[16px] text-foreground no-underline transition-colors hover:text-muted-foreground">
            Learn more <IconArrowRight size={16} />
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function GraphicCardGrid({ cards }: { cards: { title: string; desc: string; href?: string; Graphic: ComponentType }[] }) {
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-2 xl:grid-cols-3">
      {cards.map(card => (
        <GraphicCard key={card.title} {...card} />
      ))}
    </div>
  );
}

const AT = [
  'top-[-1px] left-[-1px] border-t border-l',
  'top-[-1px] right-[-1px] border-t border-r',
  'right-[-1px] bottom-[-1px] border-r border-b',
  'bottom-[-1px] left-[-1px] border-b border-l',
];

/** Corner marks on a bordered box, lit in lime while the tile is hovered. */
export function Corners() {
  return (
    <>
      {AT.map(at => (
        <span
          key={at}
          aria-hidden
          className={`pointer-events-none absolute size-3 border-[#8f8f8f] transition-colors duration-75 group-hover:border-primary ${at}`}
        />
      ))}
    </>
  );
}

/** Polar's pill buttons: white primary, ghost secondary. */
export function PillButton({ href, children, ghost = false }: { href: string; children: ReactNode; ghost?: boolean }) {
  return (
    <a
      href={href}
      className={
        ghost
          ? 'inline-flex h-9 items-center rounded-full px-4 text-[14px] text-foreground no-underline transition-colors hover:bg-white/10'
          : 'inline-flex h-9 items-center gap-1 rounded-full bg-white px-4 text-[14px] text-black no-underline transition-opacity hover:opacity-85'
      }
    >
      {children}
    </a>
  );
}
