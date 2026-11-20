'use client'

// A proposal's number as people read it. The number is the proposal's own
// (pending_operations.operation_number: per company, set when it is staged,
// never changed), so it says WHICH proposal this is. Where a walk is ("3 av
// 12") is a different thing and keeps its own words.
//
// Two forms: the sentence form "Förslag 128" where a proposal is opened (the
// line under its title, a dialog, the chat card), and the short "#128" in a
// dense row, with the sentence form as its name. A proposal without a number
// (read before the column exists, or decided before numbers) shows nothing.

import { useTranslations } from 'next-intl'
import { operationNumberOf } from '@/lib/pending-operations/operation-number'
import { cn } from '@/lib/utils'

type Numbered = { operation_number?: unknown } | null | undefined
type Translate = (key: string, values?: Record<string, string>) => string

/**
 * "Förslag 128" in the "pending" namespace, or null without a number. The
 * number goes in as text: as a number the message would group it ("2 357").
 */
export function proposalNumberLabel(op: Numbered, t: Translate): string | null {
  const number = operationNumberOf(op)
  return number === null ? null : t('proposal_number', { number: String(number) })
}

/** The short form for a dense row: "#128", quiet, tabular. Renders nothing without a number. */
export function ProposalNumber({ op, className }: { op: Numbered; className?: string }) {
  const t = useTranslations('pending')
  const number = operationNumberOf(op)
  if (number === null) return null
  const label = t('proposal_number', { number: String(number) })
  return (
    <span className={cn('shrink-0 tabular-nums text-muted-foreground', className)} title={label}>
      <span aria-hidden>{t('proposal_number_short', { number: String(number) })}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
