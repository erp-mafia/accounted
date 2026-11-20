import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { tools } from '../server'

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'
const tool = () => tools.find((candidate) => candidate.name === 'gnubok_credit_invoice')!

function original(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'F-2026042',
    document_type: 'invoice',
    status: 'sent',
    total: 12500,
    currency: 'SEK',
    journal_entry_id: null,
    paid_at: null,
    paid_amount: null,
    customer: { name: 'Testbrand AB' },
    ...overrides,
  }
}

async function stage(
  invoiceRow: Record<string, unknown>,
  accountingMethod: string,
  postsJournalEntry = false,
): Promise<{ staged: boolean; preview: Record<string, unknown>; next?: { description?: string } }> {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: invoiceRow })
  enqueue({ data: { accounting_method: accountingMethod } })
  if (postsJournalEntry) {
    // The reversal is dated today: staging reads that date's period status.
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null } })
  }
  enqueue({ data: { id: 'op-credit-1' } })

  return (await tool().execute(
    { invoice_id: INVOICE_ID },
    'company-1',
    'user-1',
    supabase as never,
  )) as { staged: boolean; preview: Record<string, unknown>; next?: { description?: string } }
}

describe('gnubok_credit_invoice: registration', () => {
  it('stays within the 280-char budget and says when the reversal posts', () => {
    expect(tool().description.length).toBeLessThanOrEqual(280)
    expect(tool().description).toMatch(/stage/i)
    // The old description promised a reversal under accrual only, which is
    // what made the agent tell cash-method users nothing would be booked.
    expect(tool().description).not.toMatch(/\(accrual\)/)
    // The condition, not the method name: the reversal follows the ledger.
    expect(tool().description).toMatch(/reached the ledger/i)
    expect(tool().description).toMatch(/kontantmetoden/i)
    expect(OPERATION_RISK_TIERS.credit_invoice).toBe('high')
  })
})

describe('gnubok_credit_invoice: staging preview (#2552)', () => {
  it('tells the agent a verifikat will be posted for a paid kontantmetod original', async () => {
    const result = await stage(
      original({
        status: 'paid',
        journal_entry_id: 'je-orig',
        paid_at: '2026-05-20',
        paid_amount: 12500,
      }),
      'cash',
      true,
    )

    expect(result.staged).toBe(true)
    expect(result.preview.posts_journal_entry).toBe(true)
    expect(String(result.preview.method)).toMatch(/1510/)
  })

  it('says no verifikat for an unpaid, never-booked kontantmetod original', async () => {
    const result = await stage(original(), 'cash')

    expect(result.staged).toBe(true)
    expect(result.preview.posts_journal_entry).toBe(false)
    expect(String(result.preview.method)).toMatch(/unpaid/i)
    expect(String(result.next?.description)).toMatch(/nothing to reverse/i)
  })

  it('always posts under faktureringsmetoden, paid or not', async () => {
    const result = await stage(original(), 'accrual', true)

    expect(result.preview.posts_journal_entry).toBe(true)
  })

  // accounted#58: an unreadable method read as faktureringsmetoden and
  // promised a reversal of a kontantmetod sale that never reached the ledger.
  it('refuses to stage when the accounting method cannot be read', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: original() })
    enqueue({ data: null, error: { code: '57014', message: 'statement timeout' } })

    await expect(
      tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'SETTINGS_ACCOUNTING_METHOD_UNREADABLE' })
    expect(findCalls('pending_operations', 'insert')).toHaveLength(0)
  })
})

// accounted#34: a self-billed original has invoice_number null by design; the
// staging title and preview read "null" and the approved commit stored KR-null.
describe('gnubok_credit_invoice: the original reference (#34)', () => {
  it('names a self-billed original by its external number and previews KR-<external number>', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: original({ invoice_number: null, external_invoice_number: 'SB-2026-17' }) })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { bookkeeping_locked_through: null } }) // period check: lock date
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null } }) // period check: period
    enqueue({ data: { id: 'op-credit-1' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.invoice_number).toBe('SB-2026-17')
    expect(result.preview.credit_note_number).toBe('KR-SB-2026-17')
    const staged = findCall('pending_operations', 'insert')?.[0] as Record<string, unknown>
    expect(staged.title).toBe('Kreditera faktura SB-2026-17')
  })

  it('refuses INVOICE_CREDIT_NO_NUMBER when the original has no number at all', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: original({ invoice_number: null, external_invoice_number: null }) })
    enqueue({ data: { accounting_method: 'accrual' } })

    await expect(
      tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_CREDIT_NO_NUMBER' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

// The guard list every credit door runs (creditNoteRefusal): staging used to
// accept a credit note as the original and the approval then posted a second
// reversal of the same sale.
describe('gnubok_credit_invoice: refusals at staging', () => {
  async function refusal(invoiceRow: Record<string, unknown>) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow })
    enqueue({ data: { accounting_method: 'accrual' } })
    return tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never)
  }

  it('refuses a credit note', async () => {
    await expect(
      refusal(original({ invoice_number: 'KR-F-2026041', credited_invoice_id: 'other-invoice' })),
    ).rejects.toMatchObject({ code: 'INVOICE_CREDIT_NOT_INVOICE' })
  })

  it('refuses a credit note imported without a link to its original (accounted#58)', async () => {
    await expect(
      refusal(original({ status: 'paid', total: -1250, credited_invoice_id: null })),
    ).rejects.toMatchObject({ code: 'INVOICE_CREDIT_NOT_INVOICE' })
  })

  it.each([
    [{ status: 'credited' }, 'INVOICE_CREDIT_ALREADY_CREDITED'],
    [{ status: 'draft' }, 'INVOICE_CREDIT_NOT_SENT'],
    [{ document_type: 'proforma' }, 'INVOICE_CREDIT_NOT_INVOICE'],
    [{ deduction_reclaimed_total: 500 }, 'INVOICE_CREDIT_ROT_RUT_RECLAIMED'],
  ])('refuses %o with %s', async (overrides, code) => {
    await expect(refusal(original(overrides))).rejects.toMatchObject({ code })
  })

  it('shows the period of today the reversal will be booked in', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: original() })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { bookkeeping_locked_through: null } }) // period check: lock date
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null } }) // period check: period
    enqueue({ data: { id: 'op-credit-2' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; period_status?: { status: string } }

    expect(result.staged).toBe(true)
    expect(result.period_status?.status).toBe('open')
  })
})

// accounted#45: under deferred booking an original that was never booked is
// booked first on its own date, then credited. Staging says so, and refuses
// up front when that date is locked instead of staging an approval that
// would be refused.
describe('gnubok_credit_invoice: a deferred original that was never booked', () => {
  const deferred = { accounting_method: 'accrual', defer_invoice_booking: true }
  const unbooked = () => original({ invoice_date: '2026-09-03', paid_amount: 0 })

  it('flags books_original_first and says the original is booked first', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: unbooked() })
    enqueue({ data: deferred })
    enqueue({ data: { bookkeeping_locked_through: null } }) // the original's date: lock date
    enqueue({ data: { id: 'fp-sep', is_closed: false, locked_at: null } }) // the original's date: period
    enqueue({ data: { bookkeeping_locked_through: null } }) // today: lock date
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null } }) // today: period
    enqueue({ data: { id: 'op-credit-3' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown>; next?: { description?: string } }

    expect(result.staged).toBe(true)
    expect(result.preview.posts_journal_entry).toBe(true)
    expect(result.preview.books_original_first).toBe(true)
    expect(String(result.preview.method)).toMatch(/books the unbooked original first/)
    expect(String(result.next?.description)).toMatch(/original is booked on its invoice date/)
  })

  it('refuses INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED at staging when the original is in a closed period', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: unbooked() })
    enqueue({ data: deferred })
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ data: { id: 'fp-sep', is_closed: true, locked_at: null } })

    await expect(
      tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages the plain reversal for a deferred original that is already booked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: original({ journal_entry_id: 'je-orig' }) })
    enqueue({ data: deferred })
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null } })
    enqueue({ data: { id: 'op-credit-4' } })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.preview.books_original_first).toBe(false)
    expect(String(result.preview.method)).toMatch(/reverses the original JE/)
  })
})
