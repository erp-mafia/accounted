/**
 * linkDocumentToVoucher: the one rule set every door that links an
 * underlag to a verifikat calls (v1, dashboard, MCP staging and approvals).
 *
 * The rules mirror the database (enforce_document_journal_entry_immutability,
 * migration 20260705100000; enforce_period_lock_documents; BFL 5 kap 6-7 §§):
 * a set link never moves, whatever the holder's status, a set line never
 * changes, a closed or locked period takes no underlag, and a line must be one
 * of the verifikat's. After the link, the inbox item carrying the document is
 * stamped on every door (CAS on both link columns).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { checkDocumentLink, linkDocumentToVoucher } from '../link-document'
import type { SupabaseClient } from '@supabase/supabase-js'

const DOC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OTHER_JE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const LINE = '11111111-1111-4111-8111-111111111111'
const PERIOD = '22222222-2222-4222-8222-222222222222'
const INBOX = '33333333-3333-4333-8333-333333333333'

function doc(overrides: Record<string, unknown> = {}) {
  return { id: DOC, file_name: 'kvitto.pdf', mime_type: 'application/pdf', journal_entry_id: null, journal_entry_line_id: null, ...overrides }
}
function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: JE,
    entry_date: '2026-09-15',
    description: 'Kontorsmaterial',
    voucher_series: 'A',
    voucher_number: 12,
    status: 'posted',
    fiscal_period_id: PERIOD,
    ...overrides,
  }
}
const OPEN_PERIOD = { id: PERIOD, period_start: '2026-01-01', is_closed: false, locked_at: null, closed_externally: false, closing_entry_id: null }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('checkDocumentLink', () => {
  it.each(['posted', 'draft', 'reversed'])(
    'refuses a document held by another verifikat that is %s, naming the holder',
    async (status) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: doc({ journal_entry_id: OTHER_JE }) })
      enqueue({ data: entry() })
      enqueue({ data: { status, voucher_series: 'A', voucher_number: 7 } })

      const result = await checkDocumentLink(supabase as unknown as SupabaseClient, 'company-1', {
        document_id: DOC,
        journal_entry_id: JE,
      })

      expect(result).toEqual({
        ok: false,
        code: 'DOC_LINK_ALREADY_LINKED',
        details: {
          holder: { journal_entry_id: OTHER_JE, status, voucher_series: 'A', voucher_number: 7 },
          current_journal_entry_id: OTHER_JE,
          line_change: false,
        },
      })
    },
  )

  it('allows a re-link to the verifikat already holding the document', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: doc({ journal_entry_id: JE }) })
    enqueue({ data: entry() })
    enqueue({ data: OPEN_PERIOD })

    const result = await checkDocumentLink(supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE })

    expect(result.ok).toBe(true)
  })

  it('refuses a change of a set line on the same verifikat (the trigger never lets it change)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: doc({ journal_entry_id: JE, journal_entry_line_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) })
    enqueue({ data: entry() })
    enqueue({ data: { id: LINE } })
    enqueue({ data: { status: 'posted', voucher_series: 'A', voucher_number: 12 } })

    const result = await checkDocumentLink(supabase as unknown as SupabaseClient, 'company-1', {
      document_id: DOC,
      journal_entry_id: JE,
      journal_entry_line_id: LINE,
    })

    expect(result).toMatchObject({ ok: false, code: 'DOC_LINK_ALREADY_LINKED', details: { line_change: true } })
  })

  it('refuses a line that is not on the verifikat: NOT_FOUND journal_entry_line', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: doc() })
    enqueue({ data: entry() })
    enqueue({ data: null }) // the line lookup scoped to the verifikat finds nothing

    const result = await checkDocumentLink(supabase as unknown as SupabaseClient, 'company-1', {
      document_id: DOC,
      journal_entry_id: JE,
      journal_entry_line_id: LINE,
    })

    expect(result).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      details: { resource: 'journal_entry_line', field: 'journal_entry_line_id' },
    })
    expect(findCalls('journal_entry_lines', 'eq')).toEqual([
      ['id', LINE],
      ['journal_entry_id', JE],
    ])
  })

  it('NOT_FOUND for a document or a verifikat outside the company', async () => {
    const missingDoc = createQueuedMockSupabase()
    missingDoc.enqueue({ data: null })
    missingDoc.enqueue({ data: entry() })
    expect(
      await checkDocumentLink(missingDoc.supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE }),
    ).toEqual({ ok: false, code: 'NOT_FOUND', details: { resource: 'document' } })

    const missingEntry = createQueuedMockSupabase()
    missingEntry.enqueue({ data: doc() })
    missingEntry.enqueue({ data: null })
    expect(
      await checkDocumentLink(missingEntry.supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE }),
    ).toEqual({ ok: false, code: 'NOT_FOUND', details: { resource: 'journal_entry', field: 'journal_entry_id' } })
  })

  it('refuses a verifikat in a locked period before anything is written', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: doc() })
    enqueue({ data: entry() })
    enqueue({ data: { ...OPEN_PERIOD, locked_at: '2026-10-01T00:00:00Z' } })

    const result = await checkDocumentLink(supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE })

    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { period: { id: PERIOD } } })
  })

  it('throws a database failure instead of answering NOT_FOUND', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    enqueue({ data: entry() })

    await expect(
      checkDocumentLink(supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE }),
    ).rejects.toMatchObject({ code: '57014' })
  })
})

describe('linkDocumentToVoucher', () => {
  it('a dry run checks every rule and writes nothing', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: doc() })
    enqueue({ data: entry() })
    enqueue({ data: OPEN_PERIOD })

    const result = await linkDocumentToVoucher(
      supabase as unknown as SupabaseClient,
      'company-1',
      { document_id: DOC, journal_entry_id: JE },
      { dryRun: true },
    )

    expect(result).toMatchObject({ ok: true, dryRun: true, target: { document: { id: DOC }, entry: { id: JE } } })
    expect(calls.some((c) => ['update', 'insert', 'delete'].includes(c.method))).toBe(false)
  })

  it('links and stamps the inbox item that carries the document, whatever inbox_item_id names', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: doc() })
    enqueue({ data: entry() })
    enqueue({ data: OPEN_PERIOD })
    enqueue({ data: { id: JE } }) // core: verifikat company check
    enqueue({ data: { ...doc(), journal_entry_id: JE } }) // core: the link update
    enqueue({ data: [{ id: 'item-carrying-the-document' }] }) // the inbox stamp

    const result = await linkDocumentToVoucher(supabase as unknown as SupabaseClient, 'company-1', {
      document_id: DOC,
      journal_entry_id: JE,
      // An unrelated item: it must not be stamped by id.
      inbox_item_id: INBOX,
    })

    expect(result).toMatchObject({ ok: true, dryRun: false, document: { id: DOC, journal_entry_id: JE } })
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([[{ created_journal_entry_id: JE }]])
    const inboxEq = findCalls('invoice_inbox_items', 'eq')
    expect(inboxEq).toContainEqual(['document_id', DOC])
    expect(inboxEq).not.toContainEqual(['id', INBOX])
    // CAS on both link columns: a supplier-invoice item never gets a second link.
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
  })

  it('stamps the carrying inbox item without inbox_item_id too (one inbox rule on every door)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: doc() })
    enqueue({ data: entry() })
    enqueue({ data: OPEN_PERIOD })
    enqueue({ data: { id: JE } })
    enqueue({ data: { ...doc(), journal_entry_id: JE } })
    enqueue({ data: [] })

    const result = await linkDocumentToVoucher(supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE })

    expect(result.ok).toBe(true)
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(1)
  })

  it('returns a refusal without touching the document', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: doc({ journal_entry_id: OTHER_JE }) })
    enqueue({ data: entry() })
    enqueue({ data: { status: 'reversed', voucher_series: 'A', voucher_number: 3 } })

    const result = await linkDocumentToVoucher(supabase as unknown as SupabaseClient, 'company-1', { document_id: DOC, journal_entry_id: JE })

    expect(result).toMatchObject({ ok: false, code: 'DOC_LINK_ALREADY_LINKED' })
    expect(findCalls('document_attachments', 'update')).toHaveLength(0)
    expect(findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })
})
