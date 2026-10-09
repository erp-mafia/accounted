/**
 * Linking a document to a verifikat is refused at STAGING for the two cases
 * the commit refuses anyway, so neither a dry run nor a staged preview looks
 * fine and then fails in /pending:
 *
 *   - the document already sits on ANOTHER verifikat, whatever its status:
 *     enforce_document_journal_entry_immutability refuses every such move,
 *     and a guard that only refused a posted holder let a document on a
 *     reversed verifikat through to an HTTP 500 at approval (agent feedback
 *     seq 932068, also 845101);
 *   - the target verifikat sits in a closed or locked fiscal period, where
 *     enforce_period_lock_documents refuses the link (agent feedback seq
 *     824135: the preview showed period_status closed and staged anyway).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { toToolError } from '../tool-result'

const linkDocument = tools.find((t) => t.name === 'gnubok_link_document_to_voucher')!
const linkDocuments = tools.find((t) => t.name === 'gnubok_link_documents_to_vouchers')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }

const DOC_ID = '00000000-0000-4000-8000-000000000101'
const TARGET_ID = '00000000-0000-4000-8000-000000000201'
const HOLDER_ID = '00000000-0000-4000-8000-000000000301'

const OPEN_2026 = {
  id: 'fp-2026',
  period_start: '2026-01-01',
  is_closed: false,
  locked_at: null,
  closed_externally: false,
  closing_entry_id: null,
}

const TARGET = {
  id: TARGET_ID,
  entry_date: '2026-03-15',
  description: 'Kvitto',
  voucher_series: 'D',
  voucher_number: 8,
  status: 'posted',
  fiscal_period_id: 'fp-2026',
}

function setup(opts: {
  docJournalEntryId?: string | null
  holder?: Record<string, unknown> | null
  period?: Record<string, unknown>
}) {
  return createTableMockSupabase({
    document_attachments: {
      data: { id: DOC_ID, file_name: 'underlag.pdf', mime_type: 'application/pdf', journal_entry_id: opts.docJournalEntryId ?? null },
    },
    // First the target, then (only when the document sits elsewhere) its holder.
    journal_entries: [{ data: TARGET }, { data: opts.holder ?? null }],
    fiscal_periods: { data: opts.period ?? OPEN_2026 },
    pending_operations: { data: [] },
    transactions: { data: [] },
  })
}

async function refusal(args: Record<string, unknown>, supabase: unknown) {
  return linkDocument
    .execute(args, COMPANY_ID, USER_ID, supabase as never, ACTOR)
    .then(() => null, (err: unknown) => err)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_document_to_voucher: refusals at staging', () => {
  it('refuses a document held by a reversed verifikat, naming it and the correct_entry path; nothing is staged', async () => {
    const { supabase, findCall } = setup({
      docJournalEntryId: HOLDER_ID,
      holder: { status: 'reversed', voucher_series: 'A', voucher_number: 57 },
    })

    const err = await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID }, supabase)

    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    const { error } = toToolError(err)
    expect(error.code).toBe('DOC_LINK_ALREADY_LINKED')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Dokumentet är redan kopplat till en verifikation.')
    expect(error.message_en).toContain(`verifikat A57 (journal_entry_id ${HOLDER_ID}, status reversed)`)
    expect(error.message_en).toContain('gnubok_correct_entry')
  })

  it('refuses a dry run the same way: a dry run that passes must mean the commit can pass', async () => {
    const { supabase } = setup({
      docJournalEntryId: HOLDER_ID,
      holder: { status: 'draft', voucher_series: 'A', voucher_number: null },
    })

    const { error } = toToolError(await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID, dry_run: true }, supabase))

    expect(error.code).toBe('DOC_LINK_ALREADY_LINKED')
    expect(error.message_en).toContain(`a draft verifikat (journal_entry_id ${HOLDER_ID})`)
  })

  it('refuses a target in a closed year with DOC_UPLOAD_PERIOD_LOCKED and the reopen tool, as the bulk tool does', async () => {
    const { supabase, findCall } = setup({
      period: { ...OPEN_2026, is_closed: true, locked_at: '2026-09-26T08:33:14Z', closed_externally: true },
    })

    const err = await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID }, supabase)

    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    const { error } = toToolError(err)
    expect(error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(error.message_en).toMatch(/^No links staged: 1 of 1 rows target verifikat in a locked or closed fiscal period/)
    expect(error.remediation).toMatchObject({
      tool: 'gnubok_reopen_fiscal_period_external',
      args: { fiscal_period_id: 'fp-2026' },
    })
  })

  it('names gnubok_unlock_period for a locked, not closed, year', async () => {
    const { supabase } = setup({ period: { ...OPEN_2026, locked_at: '2026-09-20T10:00:00Z' } })

    const { error } = toToolError(await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID, dry_run: true }, supabase))

    expect(error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(error.remediation).toMatchObject({ tool: 'gnubok_unlock_period', args: { fiscal_period_id: 'fp-2026' } })
  })

  it('previews an unlinked document into an open year as before', async () => {
    const { supabase } = setup({})

    const result = (await linkDocument.execute(
      { document_id: DOC_ID, journal_entry_id: TARGET_ID, dry_run: true },
      COMPANY_ID, USER_ID, supabase as never, ACTOR,
    )) as { dry_run: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({ voucher_label: 'D8', document_currently_linked_to_other: false })
  })

  it('lets a re-link to the SAME verifikat through: a line-level refinement, not a move', async () => {
    const { supabase } = setup({ docJournalEntryId: TARGET_ID })

    const result = (await linkDocument.execute(
      { document_id: DOC_ID, journal_entry_id: TARGET_ID, dry_run: true },
      COMPANY_ID, USER_ID, supabase as never, ACTOR,
    )) as { dry_run: boolean; preview: Record<string, unknown> }

    expect(result.dry_run).toBe(true)
    expect(result.preview).toMatchObject({ document_already_linked: true })
  })
})

describe('gnubok_link_documents_to_vouchers: a document on another verifikat of any status', () => {
  function bulkSetup(holderId: string | null) {
    return createTableMockSupabase({
      fiscal_periods: { data: [{ ...OPEN_2026, period_end: '2026-12-31' }] },
      document_attachments: {
        data: [
          { id: DOC_ID, file_name: 'underlag.pdf', mime_type: 'application/pdf', journal_entry_id: holderId },
          { id: '00000000-0000-4000-8000-000000000102', file_name: 'annat.pdf', mime_type: 'application/pdf', journal_entry_id: null },
        ],
      },
      journal_entries: {
        data: [
          { ...TARGET },
          { ...TARGET, id: '00000000-0000-4000-8000-000000000202', voucher_number: 9 },
        ],
      },
      pending_operations: { data: { id: 'op-1' } },
    })
  }
  const links = [
    { document_id: DOC_ID, voucher_series: 'D', voucher_number: 8, fiscal_year: 2026 },
    { document_id: '00000000-0000-4000-8000-000000000102', voucher_series: 'D', voucher_number: 9, fiscal_year: 2026 },
  ]

  it('previews a document held by a reversed or draft verifikat as already_linked and stages only the rest', async () => {
    // The holder's status is not even read any more: every other holder blocks.
    const { supabase, findCall } = bulkSetup(HOLDER_ID)

    const result = (await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as {
      staged: boolean
      preview: { results: Array<{ status: string }>; matched_count: number; missed_count: number }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.results.map((r) => r.status)).toEqual(['already_linked', 'matched'])
    expect(result.preview).toMatchObject({ matched_count: 1, missed_count: 1 })
    const inserted = findCall('pending_operations', 'insert')![0] as {
      title: string
      params: { links: Array<{ document_id: string }> }
    }
    expect(inserted.params.links.map((l) => l.document_id)).toEqual(['00000000-0000-4000-8000-000000000102'])
    // The title names the range and that one of two rows is left out (feedback seq 921931).
    expect(inserted.title).toBe('Koppla 1 av 2 bilagor till verifikat D9 (1 utan träff)')
  })

  it('titles a batch over several series by its first and last verifikat, series first', async () => {
    const { supabase, findCall } = createTableMockSupabase({
      fiscal_periods: { data: [{ ...OPEN_2026, period_end: '2026-12-31' }] },
      document_attachments: {
        data: [101, 102, 103].map((n) => ({
          id: `00000000-0000-4000-8000-000000000${n}`,
          file_name: `underlag-${n}.pdf`,
          mime_type: 'application/pdf',
          journal_entry_id: null,
        })),
      },
      journal_entries: {
        data: [
          { ...TARGET, id: '00000000-0000-4000-8000-000000000201', voucher_series: 'D', voucher_number: 3 },
          { ...TARGET, id: '00000000-0000-4000-8000-000000000202', voucher_series: 'A', voucher_number: 12 },
          { ...TARGET, id: '00000000-0000-4000-8000-000000000203', voucher_series: 'A', voucher_number: 9 },
        ],
      },
      pending_operations: { data: { id: 'op-1' } },
    })
    const links = [
      { document_id: '00000000-0000-4000-8000-000000000101', voucher_series: 'D', voucher_number: 3, fiscal_year: 2026 },
      { document_id: '00000000-0000-4000-8000-000000000102', voucher_series: 'A', voucher_number: 12, fiscal_year: 2026 },
      { document_id: '00000000-0000-4000-8000-000000000103', voucher_series: 'A', voucher_number: 9, fiscal_year: 2026 },
    ]

    await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)

    const inserted = findCall('pending_operations', 'insert')![0] as { title: string }
    expect(inserted.title).toBe('Koppla 3 bilagor till verifikat A9-D3')
  })
})
