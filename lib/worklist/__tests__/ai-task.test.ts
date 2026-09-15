import { describe, expect, it } from 'vitest'
import { AI_TASK_HREF, AI_TASK_LABEL_KEY, AI_TASK_ORDER, listAiTasks } from '../ai-task'
import { WORKLIST_CATEGORIES, type WorklistCategory } from '../types'

function counts(overrides: Partial<Record<WorklistCategory, number>> = {}): Record<WorklistCategory, number> {
  const base = Object.fromEntries(WORKLIST_CATEGORIES.map((c) => [c, 0])) as Record<WorklistCategory, number>
  return { ...base, ...overrides }
}

describe('listAiTasks', () => {
  it('returns nothing when nothing is pending', () => {
    expect(listAiTasks(counts(), { hasAi: true })).toEqual([])
  })

  it('lists rows in render order: bank rows before anything in Granska or Bevaka', () => {
    const c = counts({ overdue_invoice: 3, verifikat_missing_document: 2, book_transaction: 7 })
    expect(listAiTasks(c, { hasAi: true })).toEqual([
      { category: 'book_transaction', count: 7 },
      { category: 'verifikat_missing_document', count: 2 },
      { category: 'overdue_invoice', count: 3 },
    ])
  })

  it('skips rows no agent can clear: staged operations and the two Betala rows', () => {
    const c = counts({ pending_operations: 4, expense_payout: 2, skattekonto_payment_due: 1, overdue_invoice: 1 })
    expect(listAiTasks(c, { hasAi: true })).toEqual([{ category: 'overdue_invoice', count: 1 }])
  })

  it('hides the Dokumentinkorg row for non-payers, like the section does', () => {
    const c = counts({ inbox_document: 5, verifikat_missing_document: 1 })
    expect(listAiTasks(c, { hasAi: false })).toEqual([{ category: 'verifikat_missing_document', count: 1 }])
    expect(listAiTasks(c, { hasAi: true })).toEqual([
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
