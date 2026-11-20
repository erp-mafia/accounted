'use client'

// The shared parts every proposal preview is set in: typed fields as rows and
// a labelled block. One vocabulary, two densities: `compact` for the confirm
// dialog and the chat card (a two-column grid), `template` for the review of
// one proposal (hairline rows, label left, value right; canvas Att göra V8,
// KIT rule D2). A preview never chooses a density itself: it reads the one
// its surface set.

import { createContext, useContext, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn, formatCurrency } from '@/lib/utils'
import { ISO_DATE_RE } from '@/lib/invariants'
import type { FactLabel, FactRow, FactValue } from './review-model'

export type PreviewDensity = 'compact' | 'template'

export const PreviewDensityContext = createContext<PreviewDensity>('compact')

export function useIsTemplate(): boolean {
  return useContext(PreviewDensityContext) === 'template'
}

/**
 * The labels of the required fields a proposal lacks (review-model's
 * missingFields), set by the review template: a field under one of them says
 * "Saknas" where its value would be, instead of a blank or a '-'.
 */
export const MissingLabelsContext = createContext<ReadonlySet<string>>(new Set())

/**
 * The title of the proposal on the review template. A posting line whose text
 * only repeats what the title already says (a categorisation's bank text)
 * adds nothing beside it, and the room goes to the account and the amounts.
 */
export const ReviewTitleContext = createContext<string | null>(null)


/** A text longer than this reads as a paragraph: it sits under its label, left-aligned, at a readable width. */
const STACKED_TEXT = 90

/** The mark a missing required field carries in place of its value. */
export function MissingMark() {
  const t = useTranslations('pending')
  return (
    <Badge variant="warning" className="font-normal">
      {t('review_missing')}
    </Badge>
  )
}

/** A block of typed fields. `compactClassName` sets the grid's columns where two equal ones do not fit. */
export function FactList({
  children,
  className,
  compactClassName = 'grid-cols-2',
}: {
  children: ReactNode
  className?: string
  compactClassName?: string
}) {
  const template = useIsTemplate()
  if (template) return <dl className={cn('border-t-hairline text-[13px]', className)}>{children}</dl>
  return <div className={cn('grid gap-x-4 gap-y-1 text-sm', compactClassName, className)}>{children}</div>
}

/** One typed field: its label and its value. */
export function Fact({
  label,
  children,
  mono = false,
  numeric = false,
  strong = false,
  nested = false,
  alignEnd = false,
  textLength,
}: {
  label: ReactNode
  children: ReactNode
  /** An identifier (account, number, date as staged). */
  mono?: boolean
  numeric?: boolean
  /** The row the others add up to. */
  strong?: boolean
  /** A field of the group above it. */
  nested?: boolean
  /** Compact only: the value sits at the right edge (a totals block). The template always does. */
  alignEnd?: boolean
  /** Template only: the value's own length, for a free text (a reason, a note). A long one sits under its label. */
  textLength?: number
}) {
  const template = useIsTemplate()
  const missing = useContext(MissingLabelsContext)
  // The template sets identifiers and dates in the text face with tabular
  // figures (Geist Mono is for account numbers, in the ledger).
  const figures = cn((mono || numeric) && 'tabular-nums', mono && !template && 'font-mono')
  if (template) {
    const isMissing = typeof label === 'string' && missing.has(label)
    // A date as staged (2026-11-04) is set in the date figures, as every date in a list.
    const isDate = typeof children === 'string' && ISO_DATE_RE.test(children)
    if (!isMissing && textLength != null && textLength > STACKED_TEXT) {
      return (
        <div className="border-b-hairline py-2">
          <dt className="text-strong">{label}</dt>
          <dd className="mt-0.5 max-w-[70ch] break-words" data-ph-mask="">
            {children}
          </dd>
        </div>
      )
    }
    return (
      <div className="flex min-h-9 items-baseline gap-4 border-b-hairline py-2">
        <dt className={cn('shrink-0', nested ? 'pl-3 text-foreground' : 'text-strong')}>{label}</dt>
        {/* data-ph-mask: values are the company's data. */}
        <dd
          className={cn('min-w-0 flex-1 break-words text-right', isDate ? 'date-figures' : figures, strong && 'font-medium text-strong')}
          data-ph-mask=""
        >
          {isMissing ? <MissingMark /> : children}
        </dd>
      </div>
    )
  }
  return (
    <>
      <span className={cn('min-w-0 break-words', strong ? 'font-medium' : 'text-muted-foreground', nested && 'pl-3')}>{label}</span>
      <span className={cn('min-w-0 break-words', figures, strong && 'font-medium', alignEnd && 'text-right')}>{children}</span>
    </>
  )
}

/** A heading over a group of fields inside one list (an update's "Ändringar"). */
export function FactGroupLabel({ children }: { children: ReactNode }) {
  const template = useIsTemplate()
  if (template) {
    return <div className="flex min-h-9 items-end border-b-hairline pb-1.5 pt-3 text-xs font-medium text-muted-foreground">{children}</div>
  }
  return <span className="col-span-2 pt-1 text-muted-foreground">{children}</span>
}

type T = ReturnType<typeof useTranslations>

export function factLabelText(label: FactLabel, t: T): string {
  return typeof label === 'string' ? label : t(label.key)
}

function factValueNode(value: FactValue, t: T): ReactNode {
  switch (value.kind) {
    case 'money':
      return value.amount === null ? '-' : formatCurrency(value.amount, value.currency)
    case 'message':
      return t(value.key, value.values)
    case 'text':
      return value.valueKey && t.has(value.valueKey) ? t(value.valueKey) : value.text
    default:
      return value.text
  }
}

/** The typed fields of review-model's proposalFacts, one FactList per group. */
export function FactRows({ groups, totalsFrom = 1 }: { groups: FactRow[][]; totalsFrom?: number }) {
  const t = useTranslations('pending')
  const template = useIsTemplate()
  return (
    <>
      {groups.map((rows, index) =>
        rows.length === 0 ? null : (
          <FactList key={index} className={cn(!template && index > 0 && 'border-t pt-2')}>
            {rows.map((fact) => (
              <Fact
                key={fact.id}
                label={factLabelText(fact.label, t)}
                mono={fact.value.kind === 'code'}
                numeric={fact.value.kind === 'money'}
                strong={fact.strong}
                alignEnd={index >= totalsFrom && fact.value.kind === 'money'}
              >
                {factValueNode(fact.value, t)}
              </Fact>
            ))}
          </FactList>
        ),
      )}
    </>
  )
}

/**
 * A labelled block inside a preview (the verifikat a document is linked to,
 * the document). A raised object in the compact surfaces; in the template the
 * panel is already the surface, so it is a label over its content.
 */
export function PreviewBlock({ label, children }: { label: string; children: ReactNode }) {
  const template = useIsTemplate()
  return (
    <div className={cn('min-w-0 space-y-2', !template && 'rounded-lg bg-control p-3 shadow-raised')}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}
