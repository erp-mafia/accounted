import type { InvoiceDocumentType } from '@/types'

/**
 * The invoice editor's one status line, under the live preview: the first
 * thing that blocks sending (with a jump link), else why the PDF runs to
 * more than one page, else nothing. It is the page's single attention
 * sentence (design convention 6), so it never stacks a second line.
 */

/** Why a rendered draft probably ran to a second page. */
export type PageSplitCause = 'note' | 'rows' | 'deduction'

export type EditorStatusLine<TStep> =
  /** The form's next missing field (customer, dates, rows, ...): ochre, with a jump link. */
  | { kind: 'step'; step: TStep }
  /** A faktura whose payment details print nothing the customer can pay to. */
  | { kind: 'payee_missing' }
  /** The last preview request failed; the previous render stays on screen. */
  | { kind: 'preview_failed' }
  /** The PDF has more than one page: the count and the probable cause. */
  | { kind: 'split'; pages: number; cause: PageSplitCause | null }
  | { kind: 'none' }

export interface StatusLineInput<TStep extends { kind: string }> {
  /** deriveNextStep's result: kind 'ready' when nothing is missing. */
  nextStep: TStep
  /** X-Invoice-Missing of the latest preview (customer, rows, payee). */
  missing: readonly string[]
  documentType: InvoiceDocumentType
  /** X-Invoice-Page-Count of the latest preview; null before the first render. */
  pageCount: number | null
  previewFailed: boolean
  notes: string
  productRowCount: number
  hasDeduction: boolean
}

// A note this long fills a third of a page or more on its own: the likeliest
// reason a short invoice spills over.
const LONG_NOTE_CHARS = 500
const LONG_NOTE_LINES = 6
// Rows that take a page by themselves beside the header and totals.
const MANY_ROWS = 12

/**
 * The probable cause of a page split, in the order a user can act on it: a
 * long note (shorten it), many rows, then the skattereduktion box that a
 * ROT/RUT/grön teknik invoice adds above the payment area. Null when none of
 * them explains it.
 */
export function pageSplitCause(input: {
  notes: string
  productRowCount: number
  hasDeduction: boolean
}): PageSplitCause | null {
  const note = input.notes.trim()
  if (note.length > LONG_NOTE_CHARS || note.split('\n').length > LONG_NOTE_LINES) return 'note'
  if (input.productRowCount > MANY_ROWS) return 'rows'
  if (input.hasDeduction) return 'deduction'
  return null
}

export function resolveEditorStatusLine<TStep extends { kind: string }>(
  input: StatusLineInput<TStep>,
): EditorStatusLine<TStep> {
  if (input.nextStep.kind !== 'ready') return { kind: 'step', step: input.nextStep }
  // Only a faktura carries a payment area; a quote, proforma or följesedel
  // without bank details is complete.
  if (input.documentType === 'invoice' && input.missing.includes('payee')) return { kind: 'payee_missing' }
  if (input.previewFailed) return { kind: 'preview_failed' }
  if (input.pageCount !== null && input.pageCount > 1) {
    return {
      kind: 'split',
      pages: input.pageCount,
      cause: pageSplitCause(input),
    }
  }
  return { kind: 'none' }
}
