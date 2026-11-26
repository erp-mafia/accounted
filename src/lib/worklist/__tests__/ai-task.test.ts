import { describe, expect, it } from 'vitest'
import { AI_TASK_HREF, AI_TASK_LABEL_KEY, AI_TASK_ORDER, aiTaskHref, foundTasksStartOpen, listAiTasks } from '../ai-task'
import { WORKLIST_CATEGORIES, type WorklistCategory } from '../types'

function counts(overrides: Partial<Record<WorklistCategory, number>> = {}): Record<WorklistCategory, number> {
  const base = Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 0])) as Record<WorklistCategory, number>
  return { ...base, ...overrides }
}

describe('listAiTasks', () => {
  it('returns nothing when nothing is pending', () => {
    expect(listAiTasks(counts())).toEqual([])
  })

  it('lists rows in render order: bank rows before anything in Granska or Bevaka', () => {
    const c = counts({ overdue_invoice: 3, verifikat_missing_document: 2, book_transaction: 7 })
    expect(listAiTasks(c)).toEqual([
      { category: 'book_transaction', count: 7 },
      { category: 'verifikat_missing_document', count: 2 },
      { category: 'overdue_invoice', count: 3 },
    ])
  })

  it('skips rows no agent can clear: staged operations and the two Betala rows', () => {
    const c = counts({ pending_operations: 4, expense_payout: 2, skattekonto_payment_due: 1, overdue_invoice: 1 })
    expect(listAiTasks(c)).toEqual([{ category: 'overdue_invoice', count: 1 }])
  })

  it('lists the inbox row, the inbox being open on every plan', () => {
    const c = counts({ inbox_document: 5, verifikat_missing_document: 1 })
    expect(listAiTasks(c)).toEqual([
      { category: 'inbox_document', count: 5 },
      { category: 'verifikat_missing_document', count: 1 },
    ])
  })

  it('every task category is a real worklist category with a page and a label', () => {
    for (const cat of AI_TASK_ORDER) {
      expect(WORKLIST_CATEGORIES).toContain(cat)
      expect(AI_TASK_HREF[cat]).toMatch(/^\//)
      expect(AI_TASK_LABEL_KEY[cat]).toMatch(/^row_/)
    }
  })
})

describe('aiTaskHref', () => {
  it('opens the company\'s own inbox for the inbox row, the fixed page for the rest', () => {
    expect(aiTaskHref('inbox_document', '/inkorg')).toBe('/inkorg')
    expect(aiTaskHref('inbox_document', null)).toBe('/e/general/invoice-inbox')
    expect(aiTaskHref('book_transaction', '/inkorg')).toBe('/transactions?view=inbox')
  })
})

describe('foundTasksStartOpen', () => {
  it('opens the list when bank rows wait to be booked', () => {
    expect(foundTasksStartOpen([{ category: 'book_transaction', count: 24 }, { category: 'overdue_invoice', count: 1 }])).toBe(true)
  })

  it('keeps the list folded when nothing on it is a bank row', () => {
    expect(foundTasksStartOpen([{ category: 'overdue_invoice', count: 1 }, { category: 'deadline_action', count: 2 }])).toBe(false)
    expect(foundTasksStartOpen([])).toBe(false)
  })
})
