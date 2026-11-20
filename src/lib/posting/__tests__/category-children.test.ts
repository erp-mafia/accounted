/**
 * One category list: the port's keys are the top level and the inbox's
 * purchase codes their children ('<key>.<item>'). The port accepts a key or a
 * known child under its own parent, and refuses everything else, so strict
 * stops a posting with a made-up child before anything is drafted and shadow
 * posts it without the event.
 */
import { describe, expect, it, vi } from 'vitest'
import { PURCHASE_CATEGORY_CODES } from '@/lib/categories/purchase-categories'
import type { CreateJournalEntryInput, JournalEntry } from '@/types'
import { BUSINESS_EVENT_CATEGORIES, BUSINESS_EVENT_CATEGORY_PATTERN, isBusinessEventCategory } from '../categories'
import { buildRow, createPostingPort } from '../port'
import type { BusinessEventDraft, PostingAdapter } from '../types'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const EVENT_ID = '33333333-3333-4333-8333-333333333333'
const newId = () => EVENT_ID

const EVENT: BusinessEventDraft = {
  kind: 'purchase.document_booked',
  category: 'expense.software.saas',
  occurredOn: '2026-10-17',
  currency: 'SEK',
  amount: 1250,
}

const INPUT: CreateJournalEntryInput = {
  fiscal_period_id: 'period-1',
  entry_date: '2026-10-17',
  description: 'Programvaruabonnemang',
  source_type: 'inbox_item',
  lines: [
    { account_number: '5420', debit_amount: 1000, credit_amount: 0 },
    { account_number: '2641', debit_amount: 250, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
  ],
}

function harness(mode: 'shadow' | 'strict') {
  const inserted: Array<Record<string, unknown>> = []
  const supabase = {
    from: vi.fn(() => ({
      insert: vi.fn(async (row: Record<string, unknown>) => {
        inserted.push(row)
        return { error: null }
      }),
    })),
  }
  const adapter = {
    id: 'ledger' as const,
    createJournalEntry: vi.fn(async () => ({ id: 'je-1' }) as JournalEntry),
    createDraftEntry: vi.fn(async () => ({ id: 'je-1' }) as JournalEntry),
    commitEntry: vi.fn(async () => ({ id: 'je-1' }) as JournalEntry),
    reverseEntry: vi.fn(async () => ({ id: 'je-1' }) as JournalEntry),
    correctEntry: vi.fn(async () => ({ reversal: { id: 'je-1' } as JournalEntry, corrected: { id: 'je-2' } as JournalEntry })),
    createJournalEntries: vi.fn(async () => [] as JournalEntry[]),
    commitSqlPosting: vi.fn(async () => ({ data: null, error: null }) as never),
  } satisfies PostingAdapter
  const port = createPostingPort({ adapter, mode: () => mode, newId })
  const post = (category: unknown) =>
    port.postJournalEntry({
      supabase: supabase as never,
      companyId: COMPANY,
      userId: 'u',
      event: { ...EVENT, category: category as BusinessEventDraft['category'] },
      input: INPUT,
    })
  return { post, adapter, inserted }
}

describe('isBusinessEventCategory: a key or a known child of one', () => {
  it('accepts every key of the closed list', () => {
    for (const { key } of BUSINESS_EVENT_CATEGORIES) expect(isBusinessEventCategory(key), key).toBe(true)
  })

  it('accepts every purchase code: each is a child of a key, in the shape and length the database checks', () => {
    for (const code of PURCHASE_CATEGORY_CODES) {
      expect(isBusinessEventCategory(code), code).toBe(true)
      expect(code).toMatch(BUSINESS_EVENT_CATEGORY_PATTERN)
      expect(code.length).toBeLessThanOrEqual(64)
    }
    expect(isBusinessEventCategory('expense.software.saas')).toBe(true)
    expect(isBusinessEventCategory('expense.fees.memberships')).toBe(true)
  })

  it.each([
    ['an unknown child of a real key', 'expense.software.made_up'],
    ['a known item under another parent', 'expense.travel.saas'],
    ['a moved item under its old parent', 'expense.education.memberships'],
    ['a child of a key that does not exist', 'expense.made_up.saas'],
    ['a grandchild', 'expense.software.saas.annual'],
    ['an unknown top-level key', 'expense.made_up'],
    ['a transaction category', 'expense_software'],
    ['a key in the wrong case', 'Expense.Software.SaaS'],
    ['a trailing dot', 'expense.software.'],
    ['an empty string', ''],
  ])('refuses %s (%s)', (_what, value) => {
    expect(isBusinessEventCategory(value)).toBe(false)
  })

  it('refuses what is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['expense.software']]) expect(isBusinessEventCategory(value)).toBe(false)
  })
})

describe('buildRow: the row an event with a child category becomes', () => {
  it('stores the child as the event\'s category, unchanged', () => {
    expect(buildRow(COMPANY, EVENT, newId).category).toBe('expense.software.saas')
    expect(buildRow(COMPANY, { ...EVENT, category: 'expense.fees.collection' }, newId).category).toBe('expense.fees.collection')
    expect(buildRow(COMPANY, { ...EVENT, category: 'expense.fees' }, newId).category).toBe('expense.fees')
  })

  it('refuses an unknown child, or a known item under another parent', () => {
    for (const category of ['expense.software.made_up', 'expense.travel.saas']) {
      expect(() => buildRow(COMPANY, { ...EVENT, category: category as never }, newId)).toThrow(/POSTING_EVENT_INVALID: unknown category/)
    }
  })
})

describe('the port with a child category', () => {
  it('strict: records an inbox key as the event\'s category and posts with the link', async () => {
    const { post, adapter, inserted } = harness('strict')
    await post('expense.software.saas')
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ id: EVENT_ID, category: 'expense.software.saas' })
    expect(adapter.createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('strict: an unknown child stops the posting before the adapter drafts anything', async () => {
    const { post, adapter, inserted } = harness('strict')
    await expect(post('expense.software.made_up')).rejects.toThrow(/POSTING_EVENT_INVALID/)
    expect(inserted).toEqual([])
    expect(adapter.createJournalEntry).not.toHaveBeenCalled()
  })

  it('shadow: an unknown child is logged and the posting goes ahead without the event', async () => {
    const { post, adapter, inserted } = harness('shadow')
    await post('expense.travel.saas')
    expect(inserted).toEqual([])
    expect(adapter.createJournalEntry).toHaveBeenCalledTimes(1)
  })
})
