import type { MomsPeriod } from '@/types'

/**
 * What the Skatteverket checklist step should say about VAT deadlines.
 *
 * - 'date': the company's next momsdeklaration due date is known; show it.
 * - 'missing_period': the company is VAT-registered but moms_period is unset,
 *   which makes the deadline engine silently generate ZERO VAT deadlines
 *   (lib/tax/deadline-config.ts conditions all require a concrete period).
 *   An empty deadlines query in that state means misconfiguration, not
 *   "no VAT duty", so the UI must prompt for the period instead of showing
 *   nothing.
 * - null: not VAT-registered (no line), or VAT-registered with a period set
 *   but no upcoming row surfaced (transient or horizon gap; say nothing
 *   rather than guessing).
 */
export type VatDeadlineLine =
  | { kind: 'date'; dueDate: string }
  | { kind: 'missing_period' }
  | null

export function vatDeadlineLine(input: {
  vatRegistered: boolean | null | undefined
  momsPeriod: MomsPeriod | null | undefined
  nextVatDueDate: string | null | undefined
}): VatDeadlineLine {
  if (!input.vatRegistered) return null
  if (!input.momsPeriod) return { kind: 'missing_period' }
  if (!input.nextVatDueDate) return null
  return { kind: 'date', dueDate: input.nextVatDueDate }
}

/**
 * Display ordinals for the setup checklist steps. Books and bank are always
 * present; Skatteverket and the receipts/inbox step render only when their
 * extensions are enabled; the assistant step is always last. `count` drives
 * the "{count} steg så är bokföringen igång" title.
 */
export function checklistNumbers(gates: { hasSkatteverket: boolean; hasInbox: boolean }): {
  count: number
  skv: number
  receipts: number
  assistant: number
} {
  const skv = 3
  const receipts = 3 + (gates.hasSkatteverket ? 1 : 0)
  const assistant = receipts + (gates.hasInbox ? 1 : 0)
  return { count: assistant, skv, receipts, assistant }
}
