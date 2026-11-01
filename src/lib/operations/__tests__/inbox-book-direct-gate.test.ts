/**
 * The Inkorg's direct booking asks the gate every booking door asks, before the
 * verifikat posts: the link to an ignored row fails on the row's CHECK, so that
 * verifikat needed a storno, and a row booked through a voucher link has no
 * pointer for a narrower read to find.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'

const { mockCreateEntry } = vi.hoisted(() => ({ mockCreateEntry: vi.fn() }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: mockCreateEntry,
}))
vi.mock('../inbox-pair-guard', () => ({ refuseWhenPairBooked: vi.fn(async () => null) }))

import { bookInboxItemDirectly, type BookDirectContext } from '../inbox-book-direct'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const ENTRY_ID = '55555555-5555-4555-8555-555555555555'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger
log.child = vi.fn(() => log) as unknown as Logger['child']

function book(row: Record<string, unknown>, entries: unknown[] = []) {
  const { supabase } = createTableMockSupabase({
    invoice_inbox_items: { data: { id: 'item-1', matched_transaction_id: TX_ID, extracted_data: null }, error: null },
    transactions: {
      data: { id: TX_ID, journal_entry_id: null, reconciliation_method: null, is_ignored: false, transaction_voucher_links: [], ...row },
      error: null,
    },
    journal_entries: { data: entries, error: null },
  })
  const ctx = { supabase: supabase as unknown as SupabaseClient, companyId: 'company-1', userId: 'user-1', log } as BookDirectContext
  return bookInboxItemDirectly(ctx, 'item-1', {} as Parameters<typeof bookInboxItemDirectly>[2])
}

async function refusalCode(outcome: Awaited<ReturnType<typeof book>>) {
  if (outcome.ok) throw new Error('expected a refusal')
  const { status, body } = await parseJsonResponse<{ error: { code: string } }>(outcome.response)
  return { status, code: body.error.code }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('bookInboxItemDirectly: the bank row gate', () => {
  it('refuses an ignored row before the verifikat posts', async () => {
    expect(await refusalCode(await book({ is_ignored: true }))).toEqual({ status: 409, code: 'BANK_ROW_IGNORED' })
    expect(mockCreateEntry).not.toHaveBeenCalled()
  })

  it('refuses a row booked through a voucher link, which has no pointer', async () => {
    const outcome = await book(
      { transaction_voucher_links: [{ journal_entry_id: ENTRY_ID, role: 'bank_line' }] },
      [{ id: ENTRY_ID, status: 'posted', source_type: 'manual', source_id: null, voucher_series: 'A', voucher_number: 12 }],
    )
    expect(await refusalCode(outcome)).toMatchObject({ code: 'TRANSACTION_ALREADY_CATEGORIZED' })
    expect(mockCreateEntry).not.toHaveBeenCalled()
  })
})
