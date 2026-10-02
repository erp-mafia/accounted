/** Shared by the handoff UI and MCP. Keep this module browser-safe. */
export const ACCOUNTING_TASKS = {
  bookkeep: { skills: ['bookkeep'], goal: 'Prepare and, after approval, book the scoped transactions.' },
  check: { skills: ['bookkeep'], goal: 'Review the scoped accounting, explain findings and propose the next useful action.' },
  'month-close': { skills: ['month-end-close'], goal: 'Review the selected month, resolve approved issues and explain readiness to close.' },
  payroll: { skills: ['payroll-monthly'], goal: 'Prepare the requested payroll, explain the proposal and execute only the approved steps.' },
  vat: { skills: ['quarterly-vat-review'], goal: 'Review VAT for the selected dates and prepare the next step for approval.' },
  'year-end': { skills: ['year-end-close'], goal: 'Check year-end readiness and work through the eligible closing steps with the user.' },
  start: { skills: [], goal: 'Identify outstanding accounting work and help the user choose a concrete task.' },
} as const

export type AccountingTaskKind = keyof typeof ACCOUNTING_TASKS

export interface AccountingTaskScope {
  date_from?: string
  date_to?: string
  fiscal_period_id?: string
  transaction_ids?: string[]
  tax_transaction_ids?: string[]
  cash_account_id?: string
  account_key?: string
  source?: 'bank' | 'skatteverket'
  query?: string
}

export interface AccountingTaskRequest {
  kind: AccountingTaskKind | `skill:${string}`
  scope?: AccountingTaskScope
  /** The user's concrete request, including the originating worklist row. */
  request?: string
}

export function taskSkills(kind: AccountingTaskRequest['kind']): readonly string[] {
  return kind.startsWith('skill:') ? [kind.slice(6)] : ACCOUNTING_TASKS[kind as AccountingTaskKind].skills
}

/** Workflow instructions, not accounting rules. Current rules come from load_skill. */
export const ACCOUNTING_TASK_INSTRUCTIONS = [
  'Call gnubok_get_agent_briefing with company_id. Verify the company and its accounting method. Pass this company_id to every company-scoped tool; MCP resources may use a different default company.',
  'Load the listed workflow skills with gnubok_load_skill. Load relevant current domain atoms from the briefing or gnubok_list_skills when needed; do not answer Swedish accounting questions from memory. Check workflow applicability against the company before using it.',
  'Re-read live records before acting. Work only within the supplied dates, filters and record IDs. transaction_ids are bank transactions; tax_transaction_ids are skattekonto records and require their own tools. An empty explicit selection means no selected records, never all records. Ask if scope is ambiguous.',
  'Inspect existing documents, invoices, ledger history and pending proposals. Avoid duplicate bookings and proposals. Use the company\'s explicit mappings and relevant history as evidence, checking against current rules and the supporting information. Ask for missing information instead of inventing it.',
  'Use Accounted tools for calculations and all accounting changes. Discover missing tools with gnubok_search_tools and follow the returned schemas. Respect period locks and explain blocked items. This assignment does not authorize changing or reopening a locked period.',
  'Prepare staged proposals, explain their evidence and obtain the user\'s approval before committing. Approve only the operations the user explicitly accepted, following each tool\'s approval contract. A copied prompt, staged proposal or open chat does not mean the work is completed.',
  'Re-read the affected records after approved actions. Report completed work with record references, proposals awaiting approval, skipped or blocked items and their reasons, and the next useful action. If interrupted, inspect live records and pending operations before resuming.',
] as const

export const WORKLIST_TASK_KINDS = {
  book_transaction: 'bookkeep',
  book_skattekonto: 'bookkeep',
  inbox_document: 'bookkeep',
  supplier_invoice_approval: 'bookkeep',
  verifikat_missing_document: 'check',
  overdue_invoice: 'check',
  deadline_action: 'check',
  reconciliation_due: 'month-close',
} as const satisfies Record<string, AccountingTaskKind>
