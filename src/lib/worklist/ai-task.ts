import type { WorklistCategory, WorklistCounts } from './types'

/**
 * The things on Att göra that a connected AI client can do over MCP, listed
 * on Hem and in the books act's Klart step in the section's band order
 * (Bokför, Betala, Granska, Bevaka), skipping rows no agent can clear: staged
 * operations wait for a human approval, and the two Betala rows are bank
 * transfers a person makes. Each category has a row label (dashboard.row_*)
 * and the page the row opens. Only "Verifikat utan underlag" carries an AI
 * action (Kvittojakten, see components/dashboard/AiTaskAction). Pure: the
 * components only render the copy.
 */
export type AiTaskCategory = Extract<
  WorklistCategory,
  | 'book_transaction'
  | 'book_skattekonto'
  | 'inbox_document'
  | 'supplier_invoice_approval'
  | 'verifikat_missing_document'
  | 'overdue_invoice'
  | 'deadline_action'
  | 'reconciliation_due'
>

export interface AiTask {
  category: AiTaskCategory
  count: number
}

/** Render order of the Att göra rows an agent can act on. */
export const AI_TASK_ORDER: readonly AiTaskCategory[] = [
  'book_transaction',
  'book_skattekonto',
  'inbox_document',
  'supplier_invoice_approval',
  'verifikat_missing_document',
  'deadline_action',
  'overdue_invoice',
  'reconciliation_due',
]

/** The page each row opens: the same hrefs as the Att göra rows on Hem. */
export const AI_TASK_HREF: Record<AiTaskCategory, string> = {
  book_transaction: '/transactions',
  book_skattekonto: '/transactions?source=skatteverket',
  inbox_document: '/e/general/invoice-inbox',
  // The Registrerade tab: what attest still accepts, the very invoices the
  // count holds (crm#1631).
  supplier_invoice_approval: '/supplier-invoices?tab=registered',
  verifikat_missing_document: '/bookkeeping?missingUnderlag=true',
  overdue_invoice: '/invoices?status=overdue',
  deadline_action: '/deadlines',
  reconciliation_due: '/reconciliation',
}

/**
 * The page a row opens for this company: the inbox row follows the
 * company's inbox (WorklistCounts.inboxHref: the new Inkorg in the rollout),
 * the rest are fixed.
 */
export function aiTaskHref(category: AiTaskCategory, inboxHref?: string | null): string {
  return category === 'inbox_document' && inboxHref ? inboxHref : AI_TASK_HREF[category]
}

/** The row label key in the `dashboard` namespace, shared with Hem's rows. */
export const AI_TASK_LABEL_KEY = {
  book_transaction: 'row_book_transactions',
  book_skattekonto: 'row_book_skattekonto',
  inbox_document: 'row_inbox_documents',
  supplier_invoice_approval: 'row_supplier_approval',
  verifikat_missing_document: 'row_missing_underlag',
  overdue_invoice: 'row_overdue_invoices',
  deadline_action: 'row_deadlines',
  reconciliation_due: 'row_reconciliation_due',
} as const satisfies Record<AiTaskCategory, string>

/** Every agent-able row with something on it, in render order. */
export function listAiTasks(
  counts: WorklistCounts['counts'],
  opts: { hasAi: boolean },
): AiTask[] {
  const out: AiTask[] = []
  for (const category of AI_TASK_ORDER) {
    // The Dokumentinkorg row is hidden for non-payers (paid AI surface), so
    // it is not "on the list" for them either.
    if (category === 'inbox_document' && !opts.hasAi) continue
    const count = counts[category] ?? 0
    if (count > 0) out.push({ category, count })
  }
  return out
}

/**
 * Whether the books act's Klart step shows what the app found without being
 * asked. Bank rows waiting to be booked are what a first session is for,
 * and the step kept them behind a folded toggle: of the 83 people who signed
 * up in the 30 days to 2026-11-12, had rows waiting and never booked one, 57
 * had finished the act. Anything else on the list stays folded until asked.
 * A click on the toggle always wins over this.
 */
export function foundTasksStartOpen(tasks: readonly AiTask[]): boolean {
  return tasks.some((task) => task.category === 'book_transaction')
}
