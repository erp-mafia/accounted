/**
 * gnubok_link_documents_to_vouchers when no row resolves. The refusal was a
 * plain Error, so the agent read UNKNOWN_ERROR, "Något gick fel. Försök igen.",
 * for a call no retry fixes: in 30 days 10 such calls had every document on
 * another verifikat already, 6 named a document or verifikat that does not
 * exist. Each now answers a code that says what to change, and the rows a
 * document already sits on name that verifikat.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { toToolError } from '../tool-result'

const linkDocuments = tools.find((t) => t.name === 'gnubok_link_documents_to_vouchers')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }

const DOC_ON_OTHER = '00000000-0000-4000-8000-000000000101'
const DOC_FREE = '00000000-0000-4000-8000-000000000102'
const DOC_MISSING = '00000000-0000-4000-8000-000000000199'
const TARGET_ID = '00000000-0000-4000-8000-000000000201'
const SECOND_TARGET_ID = '00000000-0000-4000-8000-000000000202'
const HOLDER_ID = '00000000-0000-4000-8000-000000000301'

const OPEN_2026 = {
  id: 'fp-2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
  closed_externally: false,
  closing_entry_id: null,
}

const TARGET = {
  id: TARGET_ID,
  entry_date: '2026-03-15',
  description: 'Betalning',
  voucher_series: 'E',
  voucher_number: 18,
  status: 'posted',
  fiscal_period_id: 'fp-2026',
}

function setup() {
  return createTableMockSupabase({
    fiscal_periods: { data: [OPEN_2026] },
    document_attachments: {
      data: [
        { id: DOC_ON_OTHER, file_name: 'faktura.pdf', mime_type: 'application/pdf', journal_entry_id: HOLDER_ID },
        { id: DOC_FREE, file_name: 'kvitto.pdf', mime_type: 'application/pdf', journal_entry_id: null },
      ],
    },
    journal_entries: { data: [TARGET, { ...TARGET, id: SECOND_TARGET_ID, voucher_number: 19 }] },
    pending_operations: [{ data: [] }, { data: { id: 'op-1' } }], // the claims read; then the insert
  })
}

async function refusal(links: Array<Record<string, unknown>>, supabase: unknown) {
  return linkDocuments
    .execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)
    .then(() => null, (err: unknown) => err)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_documents_to_vouchers: no row resolves', () => {
  it('answers DOC_LINK_ALREADY_LINKED, naming the holder and copy: true, when every document is on another verifikat', async () => {
    const { supabase, findCall } = setup()

    const err = await refusal([{ document_id: DOC_ON_OTHER, journal_entry_id: TARGET_ID }], supabase)

    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    const { error } = toToolError(err)
    expect(error.code).toBe('DOC_LINK_ALREADY_LINKED')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Dokumentet är redan kopplat till en verifikation.')
    expect(error.message_en).toContain('0/1 rows')
    expect(error.message_en).toContain('already_linked 1')
    expect(error.message_en).toContain(`"linked_journal_entry_id":"${HOLDER_ID}"`)
    expect(error.remediation?.description).toContain('copy: true')
  })

  it('answers NOT_FOUND with the reason for a document id that does not exist, never UNKNOWN_ERROR', async () => {
    const { supabase } = setup()

    const { error } = toToolError(await refusal([{ document_id: DOC_MISSING, journal_entry_id: TARGET_ID }], supabase))

    expect(error.code).toBe('NOT_FOUND')
    expect(error.retryable).toBe(false)
    expect(error.message_en).toContain('document_not_found 1')
    expect(error.message_en).toContain(DOC_MISSING)
    expect(error.remediation?.description).toContain('gnubok_list_unmatched_documents')
  })

  it('answers NOT_FOUND for a voucher number that resolves to nothing', async () => {
    const { supabase } = setup()

    const { error } = toToolError(await refusal(
      [{ document_id: DOC_FREE, voucher_series: 'E', voucher_number: 99, fiscal_year: 2025 }],
      supabase,
    ))

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message_en).toContain('unknown_fiscal_year 1')
  })

  it('counts every status and leads with the ids to fix when the misses are mixed', async () => {
    const { supabase } = setup()

    const { error } = toToolError(await refusal([
      { document_id: DOC_ON_OTHER, journal_entry_id: TARGET_ID },
      { document_id: DOC_MISSING, journal_entry_id: SECOND_TARGET_ID },
    ], supabase))

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message_en).toContain('0/2 rows')
    expect(error.message_en).toContain('already_linked 1, document_not_found 1')
    expect(error.remediation?.description).toContain('document_not_found')
    expect(error.remediation?.description).toContain('copy: true')
  })
})

describe('gnubok_link_documents_to_vouchers: a partly resolved batch', () => {
  it('stages the rows that resolve, and an already_linked row names the verifikat holding the document', async () => {
    const { supabase, findCall } = setup()

    const result = (await linkDocuments.execute(
      {
        links: [
          { document_id: DOC_ON_OTHER, journal_entry_id: TARGET_ID },
          { document_id: DOC_FREE, journal_entry_id: SECOND_TARGET_ID },
        ],
      },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      ACTOR,
    )) as { staged: boolean; preview: { results: Array<Record<string, unknown>>; matched_count: number } }

    expect(result.staged).toBe(true)
    expect(result.preview.matched_count).toBe(1)
    expect(result.preview.results[0]).toMatchObject({ status: 'already_linked', linked_journal_entry_id: HOLDER_ID })
    const inserted = findCall('pending_operations', 'insert')![0] as { params: { links: Array<{ document_id: string }> } }
    expect(inserted.params.links.map((l) => l.document_id)).toEqual([DOC_FREE])
  })
})
