import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { DocumentTextIcon } from '@/components/icons'
import { StandaloneBrand } from '@/components/standalone/StandaloneBrand'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { SourceCodeFooter } from '@/components/branding/SourceCodeFooter'

/**
 * The one frame for every page outside the app shell (canvas "Utanför
 * appen"): the brand mark, then one panel in a centred column on the warm
 * frame. On a phone the frame dissolves: the panel is the whole width, the
 * mark sits left and controls grow to 44px.
 *
 * Column widths: `auth` 400px (sign in, two-factor, password), `pick` 480px
 * (a short list to choose from), `link` 520px (a page opened from a mail or a
 * text message by someone without an account), `form` 560px (a form),
 * `guide` 760px (guided steps).
 *
 * No state and no strings of its own beyond the source-code line (`common`,
 * a root namespace): it renders in server and client pages alike.
 */
const WIDTH = {
  auth: 'sm:max-w-[400px]',
  pick: 'sm:max-w-[480px]',
  link: 'sm:max-w-[520px]',
  form: 'sm:max-w-[560px]',
  guide: 'sm:max-w-[760px]',
} as const

export type StandaloneWidth = keyof typeof WIDTH

export function StandalonePage({
  width = 'auth',
  brand = true,
  hero = false,
  below = brand ? <SourceCodeFooter /> : null,
  children,
  className,
  busy,
}: {
  width?: StandaloneWidth
  /** The brand mark over the panel. A link page names its sender instead (`StandaloneFrom`). */
  brand?: boolean
  /**
   * The front door (sign in, create account): the wordmark alone over the
   * panel, the whole group centred in the window. Other pages keep the small
   * mark at the top.
   */
  hero?: boolean
  /**
   * Quiet lines under the panel. A page with the brand mark carries the
   * source-code line there (AGPL section 13 source offer, WL-06: on default
   * and branded hosts alike, never gated on a brand); pass `null` to drop it.
   */
  below?: ReactNode
  children: ReactNode
  className?: string
  busy?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-h-dvh flex-col items-center bg-background pt-4 sm:bg-frame sm:px-4 sm:py-8',
        hero && 'pt-10 sm:justify-center sm:pb-24',
      )}
    >
      {brand &&
        (hero ? (
          <BrandWordmark size="hero" className="px-4 text-strong sm:px-0" />
        ) : (
          <StandaloneBrand className="self-start px-4 sm:self-center sm:px-0" />
        ))}
      <main
        aria-busy={busy || undefined}
        className={cn(
          'w-full animate-slide-up px-4 pb-8 pt-4 sm:rounded-xl sm:bg-background sm:p-6 sm:shadow-panel',
          brand && 'sm:mt-6',
          WIDTH[width],
          className,
        )}
      >
        {children}
      </main>
      {below && (
        <div className={cn('w-full px-4 pb-6 sm:mt-4 sm:px-0 sm:pb-0', hero && 'flex flex-col gap-3 text-center', WIDTH[width])}>
          {below}
        </div>
      )}
    </div>
  )
}

/** The page's one heading (20px) with an optional line under it and an optional 12px line over it. */
export function StandaloneHeading({
  title,
  sub,
  eyebrow,
  className,
  hidden,
}: {
  title: ReactNode
  sub?: ReactNode
  eyebrow?: ReactNode
  className?: string
  /** Keep the heading for screen readers only: the wordmark and the button already say it. */
  hidden?: boolean
}) {
  if (hidden) return <h1 className="sr-only">{title}</h1>
  return (
    <header className={className}>
      {eyebrow && <p className="mb-0.5 text-xs font-medium text-muted-foreground">{eyebrow}</p>}
      <h1 className="text-xl text-strong">{title}</h1>
      {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
    </header>
  )
}

/** Fields and buttons under the heading: 12px apart, 20px under the heading. */
export function StandaloneStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-5 flex flex-col gap-3', className)}>{children}</div>
}

/** Small print: the way to the sibling page, the legal line, what a link is good for. */
export function StandaloneSmall({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mt-4 text-xs text-muted-foreground', className)}>{children}</p>
}

/** The same small print as a line under the panel (the `below` slot of a hero page). */
export function StandaloneBelowLine({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

/** The link style inside small print and sentences. */
export const STANDALONE_LINK_CLASS =
  'font-medium text-strong underline decoration-foreground/25 underline-offset-[3px] transition-colors duration-150 hover:decoration-foreground/60 pointer-coarse:inline-block pointer-coarse:py-2'

/** "eller" between the primary way and the other ways in. */
export function StandaloneOr({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-0 flex-1 border-t-hairline" aria-hidden="true" />
      {children}
      <span className="h-0 flex-1 border-t-hairline" aria-hidden="true" />
    </div>
  )
}

/**
 * Who sent a link page: the sender's initials tile and name, and the quiet
 * "via Accounted" on the right. Takes the place of the brand mark.
 */
export function StandaloneFrom({ name, via }: { name: string; via?: ReactNode }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
  return (
    <div className="flex items-center gap-2.5 border-b-hairline pb-4" data-ph-mask="">
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-strong">{name}</span>
      {via && <span className="shrink-0 text-xs text-muted-foreground">{via}</span>}
    </div>
  )
}

/** Typed rows: the label on the left, the value on the right, hairlines between. */
export function StandaloneFacts({
  rows,
  className,
}: {
  rows: Array<{ label: ReactNode; value: ReactNode; key?: string } | null | false | undefined>
  className?: string
}) {
  const shown = rows.filter((row): row is { label: ReactNode; value: ReactNode; key?: string } => !!row)
  if (shown.length === 0) return null
  return (
    <dl className={cn('border-t-hairline text-sm', className)} data-ph-mask="">
      {shown.map((row, index) => (
        <div key={row.key ?? index} className="flex min-h-9 items-baseline justify-between gap-4 border-b-hairline py-2">
          <dt className="shrink-0 text-foreground">{row.label}</dt>
          <dd className="min-w-0 text-right tabular-nums text-foreground/80">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The document as the file itself: a row with its name and the way to open it, never redrawn. */
export function StandaloneFile({
  name,
  href,
  openLabel,
}: {
  name: ReactNode
  /** Where the file opens. Left out when the page's primary is the way to the file. */
  href?: string
  openLabel?: string
}) {
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-lg bg-control px-3 py-1.5 shadow-raised" data-ph-mask="">
      <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-strong">{name}</span>
      {href && <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="-mr-1.5 flex h-7 shrink-0 items-center rounded-md px-2 text-sm font-medium text-foreground/80 transition-colors duration-150 hover:bg-secondary/60 pointer-coarse:h-11"
      >
        {openLabel}
      </a>}
    </div>
  )
}

/** A 12px label over a block ("Vad händer sedan", "Ditt svar"). */
export function StandaloneLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-xs font-medium text-muted-foreground', className)}>{children}</p>
}

/**
 * What stands in place of the action once it is used, or when the link can do
 * nothing more: a 15px title and one line that says what happened and what to
 * do next.
 */
export function StandaloneOutcome({
  title,
  children,
  mark,
  className,
}: {
  title: ReactNode
  children?: ReactNode
  /** The glyph before the title (a green check for a finished action). */
  mark?: ReactNode
  className?: string
}) {
  return (
    <div role="status" className={cn('flex items-start gap-2.5', className)}>
      {mark && <div className="mt-[3px] shrink-0">{mark}</div>}
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium leading-[22px] text-strong">{title}</p>
        {children && <div className="mt-0.5 text-sm text-foreground">{children}</div>}
      </div>
    </div>
  )
}

/**
 * A page that is only a message: a link that no longer works, a record that
 * is not there. What happened as the heading, what to do next as the line
 * under it, and at most one way on.
 */
export function StandaloneMessage({
  title,
  body,
  children,
  width = 'link',
}: {
  title: ReactNode
  body?: ReactNode
  /** The one way on (a link or a button), if there is one. */
  children?: ReactNode
  width?: StandaloneWidth
}) {
  return (
    <StandalonePage width={width}>
      <StandaloneHeading title={title} />
      {body && <p className="mt-1 text-sm text-foreground">{body}</p>}
      {children && <div className="mt-5 flex flex-col gap-3 sm:flex-row">{children}</div>}
    </StandalonePage>
  )
}
