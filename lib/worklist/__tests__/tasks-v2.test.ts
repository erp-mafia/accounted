import { describe, it, expect } from 'vitest'
import { buildAttGoraTasks, firstOpenTask, openTaskTotal, type BuildAttGoraInput } from '../tasks-v2'
import { WORKLIST_CATEGORIES } from '../types'

function counts(overrides: Partial<Record<(typeof WORKLIST_CATEGORIES)[number], number>> = {}) {
  const base = Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 0])) as BuildAttGoraInput['counts']
  return { ...base, ...overrides }
}

const baseInput: BuildAttGoraInput = {
  counts: counts(),
  hasAi: false,
  expensePayoutPeople: 0,
  expiringBankConnections: 0,
  hasActiveBankConnection: true,
  setup: null,
}

describe('buildAttGoraTasks', () => {
  it('always shows the core tasks, as done at zero', () => {
    const groups = buildAttGoraTasks(baseInput)
    const ids = groups.flatMap((g) => g.tasks.map((t) => t.id))
    expect(ids).toEqual([
      'book_transaction',
      'supplier_invoice_approval',
      'pending_operations',
      'overdue_invoice',
      'deadline_action',
    ])
    expect(groups.flatMap((g) => g.tasks).every((t) => t.state === 'done')).toBe(true)
    expect(groups.map((g) => g.id)).toEqual(['lopande', 'bevaka', 'skatt'])
  })

  it('adds conditional tasks only while they carry work', () => {
    const groups = buildAttGoraTasks({
      ...baseInput,
      counts: counts({ book_skattekonto: 2, reconciliation_due: 1, verifikat_missing_document: 3 }),
      expensePayoutPeople: 1,
      expiringBankConnections: 1,
    })
    const ids = groups.flatMap((g) => g.tasks.map((t) => t.id))
    expect(ids).toContain('book_skattekonto')
    expect(ids).toContain('expense_payout')
    expect(ids).toContain('reconciliation_due')
    expect(ids).toContain('verifikat_missing_document')
    expect(ids).toContain('bank_consent')
    expect(groups.find((g) => g.id === 'bevaka')?.tasks.map((t) => t.id)).toEqual([
      'verifikat_missing_document',
      'overdue_invoice',
      'reconciliation_due',
      'bank_consent',
    ])
  })

  it('hides the Dokumentinkorg task for companies without the AI capability', () => {
    const withoutAi = buildAttGoraTasks({ ...baseInput, counts: counts({ inbox_document: 4 }) })
    expect(withoutAi.flatMap((g) => g.tasks.map((t) => t.id))).not.toContain('inbox_document')
    const withAi = buildAttGoraTasks({ ...baseInput, hasAi: true, counts: counts({ inbox_document: 4 }) })
    const inbox = withAi.flatMap((g) => g.tasks).find((t) => t.id === 'inbox_document')
    expect(inbox?.count).toBe(4)
    expect(inbox?.state).toBe('open')
  })

  it('puts the first-run steps in a Kom igång group with their own done flags', () => {
    const groups = buildAttGoraTasks({
      ...baseInput,
      setup: { open: true, bank: true, import: false, skatteverket: false, receipts: true, claude: false },
    })
    expect(groups[0].id).toBe('setup')
    expect(groups[0].tasks.map((t) => [t.id, t.state])).toEqual([
      ['setup_bank', 'done'],
      ['setup_import', 'open'],
      ['setup_skatteverket', 'open'],
      ['setup_receipts', 'done'],
      ['setup_claude', 'open'],
    ])
  })

  it('makes transaction review depend on a bank connection when none is active', () => {
    const groups = buildAttGoraTasks({ ...baseInput, hasActiveBankConnection: false })
    const book = groups.flatMap((g) => g.tasks).find((t) => t.id === 'book_transaction')
    expect(book?.deps).toEqual(['setup_bank'])
    const connected = buildAttGoraTasks(baseInput)
    expect(connected.flatMap((g) => g.tasks).find((t) => t.id === 'book_transaction')?.deps).toEqual([])
  })

  it('selects the first open task and sums open items', () => {
    const groups = buildAttGoraTasks({
      ...baseInput,
      counts: counts({ supplier_invoice_approval: 3, deadline_action: 1 }),
    })
    expect(firstOpenTask(groups)?.id).toBe('supplier_invoice_approval')
    expect(openTaskTotal(groups)).toBe(4)
    expect(firstOpenTask(buildAttGoraTasks(baseInput))?.id).toBe('book_transaction')
  })
})
