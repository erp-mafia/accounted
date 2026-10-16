/**
 * gnubok_get_record on a journal entry carries what is linked to it, each
 * link with its recorded basis (src/lib/links/voucher-links.ts). The reader
 * itself is tested in src/lib/links; here it is mocked so the tool contract
 * is what is pinned: the compact links, and links_unavailable (not an empty
 * list) when the lookup fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/links/voucher-links', async () => {
  const actual = await vi.importActual<typeof import('@/lib/links/voucher-links')>('@/lib/links/voucher-links')
  return { ...actual, getVoucherLinks: vi.fn() }
})
vi.mock('@/lib/suggestion-log/receipts', async () => {
  const actual = await vi.importActual<typeof import('@/lib/suggestion-log/receipts')>('@/lib/suggestion-log/receipts')
  return { ...actual, getDecisionReceipts: vi.fn(async () => []) }
})

import { tools } from '../server'
import { getVoucherLinks, type VoucherLink } from '@/lib/links/voucher-links'

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TX = '11111111-1111-4111-8111-111111111111'
const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const mockLinks = getVoucherLinks as ReturnType<typeof vi.fn>
const getRecord = tools.find((t) => t.name === 'gnubok_get_record')!

const NONE = {
  transaction_id: null,
  via: null,
  document_id: null,
  invoice_id: null,
  invoice_payment_id: null,
  supplier_invoice_id: null,
  supplier_invoice_payment_id: null,
  settlement_id: null,
} as const

function voucher() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: { id: JE, voucher_series: 'A', voucher_number: 7, entry_date: '2026-10-16', description: 'Bankavgift' } })
  mock.enqueue({ data: [] }) // no documents
  return mock.supabase as unknown as SupabaseClient
}

beforeEach(() => {
  mockLinks.mockReset()
})

describe('gnubok_get_record journal_entry links', () => {
  it('answers each link compactly with its basis and evidence, read for this company and verifikat', async () => {
    const links: VoucherLink[] = [
      { ...NONE, kind: 'bank_transaction', transaction_id: TX, via: 'pointer', basis: 'agent_proposed_user_approved', evidence: { pending_operation_id: '22222222-2222-4222-8222-222222222222' } },
      { ...NONE, kind: 'document', document_id: DOC, basis: null, evidence: null },
    ]
    mockLinks.mockResolvedValue(links)
    const supabase = voucher()
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', supabase)) as { journal_entry: Record<string, unknown> }
    expect(mockLinks).toHaveBeenCalledWith(supabase, CO, JE)
    expect(out.journal_entry.links).toEqual([
      { kind: 'bank_transaction', transaction_id: TX, via: 'pointer', basis: 'agent_proposed_user_approved', evidence: { pending_operation_id: '22222222-2222-4222-8222-222222222222' } },
      // A link made before the basis was recorded says so: null, never a guess.
      { kind: 'document', document_id: DOC, basis: null },
    ])
    expect(out.journal_entry).not.toHaveProperty('links_unavailable')
  })

  it('a failed link lookup keeps the record and says links_unavailable, never an empty list', async () => {
    mockLinks.mockRejectedValue(new Error('canceling statement due to statement timeout'))
    const out = (await getRecord.execute({ record_ref: `journal_entry:${JE}` }, CO, 'user-1', voucher())) as { journal_entry: Record<string, unknown> }
    expect(out.journal_entry.voucher).toBe('A7')
    expect(out.journal_entry).not.toHaveProperty('links')
    expect(out.journal_entry.links_unavailable).toBe(true)
  })
})
