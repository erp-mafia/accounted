import type { WorklistCategory } from './types'

/**
 * Att göra in shell v2 (dev_docs/ui_v2_build_plan.md, PR 3): the worklist
 * categories arranged as a task tree. Pure: the home page computes counts
 * and flags, this turns them into groups, tasks, states and dependencies.
 * The counts themselves never originate here (lib/worklist owns them).
 */

export type AttGoraGroupId = 'setup' | 'lopande' | 'bevaka' | 'skatt'

export type AttGoraSetupTaskId =
  | 'setup_bank'
  | 'setup_import'
  | 'setup_skatteverket'
  | 'setup_receipts'
  | 'setup_claude'

export type AttGoraTaskId = AttGoraSetupTaskId | WorklistCategory | 'bank_consent'

export type AttGoraTaskState = 'open' | 'done'

export interface AttGoraTask {
  id: AttGoraTaskId
  group: AttGoraGroupId
  /** Items behind the task (people for expense_payout, connections for bank_consent). */
  count: number
  state: AttGoraTaskState
  /** Where the full page for this work lives. */
  href: string
  /** Tasks this one waits on; resolved to labels and links by the UI. */
  deps: AttGoraTaskId[]
}

export interface AttGoraGroup {
  id: AttGoraGroupId
  tasks: AttGoraTask[]
}

export interface AttGoraSetupFlags {
  /** The first-run checklist is neither completed nor dismissed. */
  open: boolean
  bank: boolean
  import: boolean
  skatteverket: boolean
  receipts: boolean
  claude: boolean
}

export interface BuildAttGoraInput {
  counts: Record<WorklistCategory, number>
  /** Paid AI capability: the Dokumentinkorg row exists only for payers. */
  hasAi: boolean
  /** People owed for utlägg (one task row per person is the page's job; the tree counts people). */
  expensePayoutPeople: number
  expiringBankConnections: number
  hasActiveBankConnection: boolean
  setup: AttGoraSetupFlags | null
}

export const ATT_GORA_TASK_HREF: Record<AttGoraTaskId, string> = {
  setup_bank: '/settings/banking',
  setup_import: '/import',
  setup_skatteverket: '/settings/skatteverket',
  setup_receipts: '/e/general/invoice-inbox',
  setup_claude: '/settings/api',
  book_transaction: '/transactions',
  book_skattekonto: '/transactions?source=skatteverket',
  inbox_document: '/e/general/invoice-inbox',
  suggested_match: '/transactions',
  supplier_invoice_approval: '/supplier-invoices',
  verifikat_missing_document: '/bookkeeping?missingUnderlag=true',
  overdue_invoice: '/invoices?status=unpaid',
  deadline_action: '/deadlines',
  pending_operations: '/pending',
  reconciliation_due: '/reconciliation',
  expense_payout: '/expenses',
  bank_consent: '/settings/banking',
}

/**
 * Tasks that stay in the tree at zero (shown as done) because every company
 * has them. The rest appear only while they carry work: a company that never
 * signs off accounts or has no utlägg should not see those rows.
 */
const ALWAYS_SHOWN: ReadonlySet<AttGoraTaskId> = new Set<AttGoraTaskId>([
  'book_transaction',
  'supplier_invoice_approval',
  'pending_operations',
  'overdue_invoice',
  'deadline_action',
])

const LOPANDE_ORDER: WorklistCategory[] = [
  'book_transaction',
  'book_skattekonto',
  'suggested_match',
  'inbox_document',
  'supplier_invoice_approval',
  'expense_payout',
  'pending_operations',
]

const BEVAKA_ORDER: WorklistCategory[] = [
  'verifikat_missing_document',
  'overdue_invoice',
  'reconciliation_due',
]

export function buildAttGoraTasks(input: BuildAttGoraInput): AttGoraGroup[] {
  const groups: AttGoraGroup[] = []

  if (input.setup?.open) {
    const s = input.setup
    const setupTask = (id: AttGoraSetupTaskId, done: boolean): AttGoraTask => ({
      id,
      group: 'setup',
      count: done ? 0 : 1,
      state: done ? 'done' : 'open',
      href: ATT_GORA_TASK_HREF[id],
      deps: [],
    })
    groups.push({
      id: 'setup',
      tasks: [
        setupTask('setup_bank', s.bank),
        setupTask('setup_import', s.import),
        setupTask('setup_skatteverket', s.skatteverket),
        setupTask('setup_receipts', s.receipts),
        setupTask('setup_claude', s.claude),
      ],
    })
  }

  const countFor = (id: AttGoraTaskId): number => {
    if (id === 'expense_payout') return input.expensePayoutPeople
    if (id === 'bank_consent') return input.expiringBankConnections
    return input.counts[id as WorklistCategory] ?? 0
  }

  const include = (id: AttGoraTaskId): boolean => {
    if (id === 'inbox_document' && !input.hasAi) return false
    return ALWAYS_SHOWN.has(id) || countFor(id) > 0
  }

  const task = (id: AttGoraTaskId, group: AttGoraGroupId): AttGoraTask => {
    const count = countFor(id)
    const deps: AttGoraTaskId[] =
      id === 'book_transaction' && !input.hasActiveBankConnection ? ['setup_bank'] : []
    return { id, group, count, state: count > 0 ? 'open' : 'done', href: ATT_GORA_TASK_HREF[id], deps }
  }

  groups.push({
    id: 'lopande',
    tasks: LOPANDE_ORDER.filter(include).map((id) => task(id, 'lopande')),
  })

  const bevaka: AttGoraTask[] = BEVAKA_ORDER.filter(include).map((id) => task(id, 'bevaka'))
  if (include('bank_consent')) bevaka.push(task('bank_consent', 'bevaka'))
  groups.push({ id: 'bevaka', tasks: bevaka })

  groups.push({ id: 'skatt', tasks: [task('deadline_action', 'skatt')] })

  return groups
}

/** Open tasks in tree order: the default selection is the first of these. */
export function firstOpenTask(groups: AttGoraGroup[]): AttGoraTask | null {
  for (const g of groups) {
    const open = g.tasks.find((t) => t.state === 'open')
    if (open) return open
  }
  return groups[0]?.tasks[0] ?? null
}

/** Sum of open items shown in the tree (setup steps count as one each). */
export function openTaskTotal(groups: AttGoraGroup[]): number {
  return groups.reduce(
    (sum, g) => sum + g.tasks.reduce((s, t) => s + (t.state === 'open' ? t.count : 0), 0),
    0,
  )
}
