import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const linkDocumentCopyToVoucher = vi.fn()
vi.mock('@/lib/documents/link-document', () => ({
  linkDocumentCopyToVoucher: (...args: unknown[]) => linkDocumentCopyToVoucher(...args),
}))
const resolvePeriodStatusForDate = vi.fn()
vi.mock('@/lib/core/bookkeeping/period-status', () => ({
  resolvePeriodStatusForDate: (...args: unknown[]) => resolvePeriodStatusForDate(...args),
}))

import { strikeDocumentLink } from '../strike-link'

/**
 * Striking the link of an underlag attached to the wrong verifikat: the rules
 * the app asks before anything is written, the copy before the strike, and
 * the trigger's refusals read back as codes. The database rules themselves are
 * tests/pg/document-link-strike.pg.test.ts.
 */

const DOC = '11111111-1111-4111-8111-111111111111'
const WRONG = '22222222-2222-4222-8222-222222222222'
const RIGHT = '33333333-3333-4333-8333-333333333333'
const COPY = '44444444-4444-4444-8444-444444444444'

type Calls = { method: string; args: unknown[] }[]
const eqValue = (chain: Calls, column: string) => chain.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]
const isUpdate = (chain: Calls) => chain.some((c) => c.method === 'update')

function setup(overrides: {
  doc?: Record<string, unknown> | null
  wrongStatus?: string | null
  right?: Record<string, unknown> | null
  txPin?: boolean
  siPin?: boolean
  update?: { data: unknown; error?: unknown }
} = {}) {
  const doc = overrides.doc === undefined
    ? { id: DOC, journal_entry_id: WRONG, is_current_version: true, link_struck_at: null }
    : overrides.doc
  const struck = {
    id: DOC,
    file_name: 'kvitto.pdf',
    journal_entry_id: WRONG,
    link_struck_at: '2026-11-27T10:00:00Z',
    link_struck_by: 'user-1',
    link_struck_reason: 'Hör till A12',
    link_struck_copy_id: COPY,
  }
  return createTableMockSupabase({
    document_attachments: (chain) => (isUpdate(chain) ? overrides.update ?? { data: struck } : { data: doc }),
    journal_entries: (chain) => {
      const id = eqValue(chain, 'id')
      if (id === WRONG) {
        return { data: overrides.wrongStatus === null ? null : { id: WRONG, status: overrides.wrongStatus ?? 'posted', entry_date: '2026-09-02' } }
      }
      return { data: overrides.right === undefined ? { id: RIGHT, status: 'posted' } : overrides.right }
    },
    transactions: { data: overrides.txPin ? [{ id: 'tx-1' }] : [] },
    supplier_invoices: { data: overrides.siPin ? [{ id: 'si-1' }] : [] },
  })
}

const input = { document_id: DOC, journal_entry_id: RIGHT, reason: '  Hör till A12  ' }

describe('strikeDocumentLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolvePeriodStatusForDate.mockResolvedValue({ period_id: 'p1', status: 'open', lock_date: null })
    linkDocumentCopyToVoucher.mockResolvedValue({
      ok: true,
      document: { id: COPY, journal_entry_id: RIGHT },
      source_document_id: DOC,
      target: {},
      reused: false,
    })
  })

  it('gives the right verifikat its copy, then strikes the link with the reason and the copy', async () => {
    const { supabase, findCalls } = setup()

    const result = await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)

    expect(result).toEqual({
      ok: true,
      document: expect.objectContaining({ id: DOC, journal_entry_id: WRONG, link_struck_copy_id: COPY }),
      copy: { id: COPY, journal_entry_id: RIGHT, reused: false },
    })
    expect(linkDocumentCopyToVoucher).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      document_id: DOC,
      journal_entry_id: RIGHT,
    })
    const [update] = findCalls('document_attachments', 'update')[0] as [Record<string, unknown>]
    expect(update).toMatchObject({ link_struck_by: 'user-1', link_struck_reason: 'Hör till A12', link_struck_copy_id: COPY })
    // Nothing moves: the update names only the strike's own columns.
    expect(Object.keys(update).sort()).toEqual(['link_struck_at', 'link_struck_by', 'link_struck_copy_id', 'link_struck_reason'])
    // Only an unstruck row is struck.
    expect(findCalls('document_attachments', 'is')).toContainEqual(['link_struck_at', null])
    // The window is read for the date of the verifikat that holds the document.
    expect(resolvePeriodStatusForDate).toHaveBeenCalledWith(supabase, 'company-1', '2026-09-02')
  })

  it.each([
    ['a document on no verifikat', { doc: { id: DOC, journal_entry_id: null, is_current_version: true, link_struck_at: null } }, 'DOC_STRIKE_NOT_LINKED'],
    ['a link already struck', { doc: { id: DOC, journal_entry_id: WRONG, is_current_version: true, link_struck_at: '2026-11-01T00:00:00Z' } }, 'DOC_STRIKE_ALREADY_STRUCK'],
    ['an old version', { doc: { id: DOC, journal_entry_id: WRONG, is_current_version: false, link_struck_at: null } }, 'DOC_STRIKE_NOT_CURRENT'],
    ['a draft verifikat', { wrongStatus: 'draft' }, 'DOC_STRIKE_NOT_POSTED'],
    ['a right verifikat that is not posted', { right: { id: RIGHT, status: 'draft' } }, 'DOC_STRIKE_TARGET_NOT_POSTED'],
    ['the underlag of a bank transaction', { txPin: true }, 'DOC_STRIKE_PINNED_TRANSACTION'],
    ['the original underlag of a supplier invoice', { siPin: true }, 'DOC_STRIKE_PINNED_SUPPLIER_INVOICE'],
  ] as const)('refuses %s before anything is written', async (_label, overrides, code) => {
    const { supabase, findCalls } = setup(overrides as Parameters<typeof setup>[0])

    const result = await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)

    expect(result).toEqual({ ok: false, code })
    expect(linkDocumentCopyToVoucher).not.toHaveBeenCalled()
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })

  it('refuses the verifikat the document is already on as the right one', async () => {
    const { supabase } = setup()
    const result = await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...input,
      journal_entry_id: WRONG,
    })
    expect(result).toEqual({ ok: false, code: 'DOC_STRIKE_SAME_VERIFIKAT' })
  })

  it('answers not found for a document or a right verifikat the company does not have', async () => {
    const missingDoc = setup({ doc: null })
    expect(await strikeDocumentLink(missingDoc.supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      resource: 'document',
    })
    const missingEntry = setup({ right: null })
    expect(await strikeDocumentLink(missingEntry.supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      resource: 'journal_entry',
    })
  })

  it('refuses a blank reason', async () => {
    const { supabase } = setup()
    expect(
      await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', { ...input, reason: '   ' }),
    ).toEqual({ ok: false, code: 'DOC_STRIKE_REASON_REQUIRED' })
  })

  it('refuses outside the window of a rättelse in the same verifikat, before the copy', async () => {
    resolvePeriodStatusForDate.mockResolvedValue({ period_id: 'p1', status: 'locked', lock_date: '2026-09-30' })
    const { supabase, findCalls } = setup()

    const result = await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)

    expect(result).toEqual({ ok: false, code: 'DOC_STRIKE_PERIOD_LOCKED' })
    expect(linkDocumentCopyToVoucher).not.toHaveBeenCalled()
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })

  it('strikes nothing when the right verifikat cannot take the copy', async () => {
    linkDocumentCopyToVoucher.mockResolvedValue({ ok: false, code: 'PERIOD_LOCKED', details: { period: {} } })
    const { supabase, findCalls } = setup()

    const result = await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)

    expect(result).toEqual({ ok: false, code: 'DOC_STRIKE_TARGET_PERIOD_LOCKED' })
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })

  it('reads the trigger\'s refusal back as its code', async () => {
    const { supabase } = setup({
      update: { data: null, error: { code: 'P0001', message: 'DOC_STRIKE_PERIOD_LOCKED: the verifikat of document x is in a closed or locked period' } },
    })
    expect(await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)).toEqual({
      ok: false,
      code: 'DOC_STRIKE_PERIOD_LOCKED',
    })
  })

  it('answers already struck when another strike of the same link won', async () => {
    const { supabase } = setup({ update: { data: null } })
    expect(await strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)).toEqual({
      ok: false,
      code: 'DOC_STRIKE_ALREADY_STRUCK',
    })
  })

  it('throws a database failure that is no rule', async () => {
    const { supabase } = setup({ update: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } })
    await expect(strikeDocumentLink(supabase as unknown as SupabaseClient, 'company-1', 'user-1', input)).rejects.toThrow()
  })
})
