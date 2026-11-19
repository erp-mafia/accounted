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
 *     824135: the preview showed period_status closed and staged anyway);
 *   - another waiting proposal already links the document to a DIFFERENT
 *     verifikat: whichever is approved second meets the same immutability
 *     trigger, and the shared-document warning used to invite approving
 *     both (crm#1158: one bank statement staged for two bank fees).
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
  /** Waiting link proposals on the document (the claims read); then the insert. */
  pending?: Array<{ id: string; params: Record<string, unknown> }>
}) {
  return createTableMockSupabase({
    document_attachments: {
      data: { id: DOC_ID, file_name: 'underlag.pdf', mime_type: 'application/pdf', journal_entry_id: opts.docJournalEntryId ?? null },
    },
    // First the target, then (only when the document sits elsewhere) its holder.
    journal_entries: [{ data: TARGET }, { data: opts.holder ?? null }],
    fiscal_periods: { data: opts.period ?? OPEN_2026 },
    pending_operations: [{ data: opts.pending ?? [] }, { data: { id: 'op-new' } }],
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
    // crm#1207, crm#1171 item 9: a verifikat that needs the same underlag
    // gets a copy from this same tool, never "upload it again" (the upload
    // door returns the existing document for identical bytes).
    expect(error.message_en).toContain('stage this link again with copy: true')
    expect(error.message_en).toContain('Do not re-upload or alter the file')
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

  it('refuses a line that is not on the target verifikat, dry run included: the pin would be permanent', async () => {
    // The approval refuses it too (lib/documents/link-document.ts); staging
    // used to let any existing line id through.
    const { supabase, findCall } = createTableMockSupabase({
      document_attachments: {
        data: { id: DOC_ID, file_name: 'underlag.pdf', mime_type: 'application/pdf', journal_entry_id: null, journal_entry_line_id: null },
      },
      journal_entries: { data: TARGET },
      journal_entry_lines: { data: null },
      fiscal_periods: { data: OPEN_2026 },
      pending_operations: [{ data: [] }, { data: { id: 'op-new' } }],
    })
    const LINE_OF_ANOTHER = '00000000-0000-4000-8000-000000000601'

    const { error } = toToolError(
      await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID, journal_entry_line_id: LINE_OF_ANOTHER, dry_run: true }, supabase),
    )

    expect(error.code).toBe('NOT_FOUND')
    expect(error.message_en).toContain(`no line with id ${LINE_OF_ANOTHER} on verifikat ${TARGET_ID}`)
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  describe('another waiting proposal holds the document (crm#1158)', () => {
    const OTHER_TARGET_ID = '00000000-0000-4000-8000-000000000202'
    const OTHER_OP_ID = '00000000-0000-4000-8000-000000000401'
    const TX_ID = '00000000-0000-4000-8000-000000000501'

    it('refuses a document another proposal links to a different verifikat, naming it and both ways out; nothing is staged', async () => {
      const { supabase, findCall } = setup({
        pending: [{ id: OTHER_OP_ID, params: { document_id: DOC_ID, journal_entry_id: OTHER_TARGET_ID } }],
      })

      const err = await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID }, supabase)

      expect(findCall('pending_operations', 'insert')).toBeUndefined()
      const { error } = toToolError(err)
      expect(error.code).toBe('DOC_LINK_PROPOSED_ELSEWHERE')
      expect(error.retryable).toBe(false)
      expect(error.message_sv).toContain('ett underlag kan bara kopplas till en verifikation')
      expect(error.message_sv).toContain('kopplas en exakt kopia till den här verifikationen')
      expect(error.message_sv).toContain('avvisa det andra förslaget')
      expect(error.message_sv).not.toContain('flera delar')
      expect(error.message_en).toContain(`pending operation ${OTHER_OP_ID} (journal_entry_id ${OTHER_TARGET_ID})`)
      // crm#1207: the way out is a copy, not a re-upload that dedups.
      expect(error.message_en).toContain('stage this link again with copy: true')
      expect(error.message_en).not.toContain('gnubok_upload_document')
      expect(error.message_en).toContain('gnubok_reject_pending_operation')
    })

    it('refuses a dry run the same way, and a row of a waiting bulk batch counts too', async () => {
      const { supabase } = setup({
        pending: [{ id: OTHER_OP_ID, params: { links: [{ document_id: DOC_ID, journal_entry_id: OTHER_TARGET_ID }] } }],
      })

      const { error } = toToolError(await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID, dry_run: true }, supabase))

      expect(error.code).toBe('DOC_LINK_PROPOSED_ELSEWHERE')
    })

    it('stages when the waiting proposal links the document to the SAME verifikat: a retry, not a conflict', async () => {
      const { supabase, findCall } = setup({
        pending: [{ id: OTHER_OP_ID, params: { document_id: DOC_ID, journal_entry_id: TARGET_ID } }],
      })

      const result = (await linkDocument.execute(
        { document_id: DOC_ID, journal_entry_id: TARGET_ID },
        COMPANY_ID, USER_ID, supabase as never, ACTOR,
      )) as { staged: boolean; preview: Record<string, unknown> }

      expect(result.staged).toBe(true)
      expect(findCall('pending_operations', 'insert')).toBeDefined()
      expect(result.preview.compliance_warning).toBeUndefined()
    })

    it('stages next to a proposal for a bank transaction, warning that only one verifikat can get the document', async () => {
      const { supabase } = setup({
        pending: [{ id: OTHER_OP_ID, params: { document_id: DOC_ID, transaction_id: TX_ID } }],
      })

      const result = (await linkDocument.execute(
        { document_id: DOC_ID, journal_entry_id: TARGET_ID, dry_run: true },
        COMPANY_ID, USER_ID, supabase as never, ACTOR,
      )) as { dry_run: boolean; preview: Record<string, unknown> }

      expect(result.dry_run).toBe(true)
      const warning = result.preview.compliance_warning as string
      expect(warning).toContain('banktransaktion 00000000')
      expect(warning).toContain('bara en av verifikationerna kan få det')
      expect(warning).toContain('egen kopia per verifikation')
      expect(warning).not.toContain('flera delar')
    })
  })
})

describe('gnubok_link_document_to_voucher: copy: true, one underlag on several verifikat (crm#1171 item 9)', () => {
  // Feedback seq 1353328: one bank statement lists two 1,49 kr fees booked as
  // two verifikat; only one could carry the statement as underlag.
  type Staged = { staged?: boolean; dry_run?: boolean; preview: Record<string, unknown> }
  type Inserted = { title: string; params: Record<string, unknown> }
  const HOLDER = { status: 'posted', voucher_series: 'A', voucher_number: 22 }

  function copySetup(opts: {
    docJournalEntryId?: string | null
    docType?: string | null
    period?: Record<string, unknown>
    pending?: Array<{ id: string; params: Record<string, unknown> }>
  }) {
    const held = opts.docJournalEntryId != null
    return createTableMockSupabase({
      document_attachments: {
        data: {
          id: DOC_ID, file_name: 'kontoutdrag.pdf', mime_type: 'application/pdf', doc_type: opts.docType ?? null,
          journal_entry_id: opts.docJournalEntryId ?? null, journal_entry_line_id: null,
        },
      },
      // The plain check reads the target and then the holder; the copy check
      // reads the target again.
      journal_entries: held ? [{ data: TARGET }, { data: HOLDER }, { data: TARGET }] : [{ data: TARGET }],
      fiscal_periods: { data: opts.period ?? OPEN_2026 },
      pending_operations: [{ data: opts.pending ?? [] }, { data: { id: 'op-new' } }],
      transactions: { data: [] },
    })
  }
  const stage = (args: Record<string, unknown>, supabase: unknown) =>
    linkDocument.execute(args, COMPANY_ID, USER_ID, supabase as never, ACTOR) as Promise<Staged>

  it('stages a copy for a document another verifikat holds, titled as a copy, the document itself untouched', async () => {
    const { supabase, findCall } = copySetup({ docJournalEntryId: HOLDER_ID, docType: 'bank_statement' })

    const result = await stage({ document_id: DOC_ID, journal_entry_id: TARGET_ID, copy: true }, supabase)

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')![0] as Inserted
    expect(inserted.title).toBe('Koppla kopia av bilaga: kontoutdrag.pdf → verifikat D8')
    expect(inserted.params).toEqual({ document_id: DOC_ID, journal_entry_id: TARGET_ID, journal_entry_line_id: null, copy: true })
    expect(result.preview).toMatchObject({ copy: true, document_current_journal_entry_id: HOLDER_ID, voucher_label: 'D8' })
    // A bank statement backing two fees is the ordinary case: no warning.
    expect(result.preview.compliance_warning).toBeUndefined()
    expect(findCall('document_attachments', 'update')).toBeUndefined()
  })

  it('warns the approver that a copied receipt can mean the same purchase booked twice', async () => {
    const { supabase } = copySetup({ docJournalEntryId: HOLDER_ID, docType: 'receipt' })

    const result = await stage({ document_id: DOC_ID, journal_entry_id: TARGET_ID, copy: true, dry_run: true }, supabase)

    expect(result.dry_run).toBe(true)
    expect(result.preview.compliance_warning).toContain('bokfört två gånger')
  })

  it('stages a copy instead of refusing when another waiting proposal links the document elsewhere', async () => {
    const { supabase, findCall } = copySetup({
      pending: [{ id: '00000000-0000-4000-8000-000000000401', params: { document_id: DOC_ID, journal_entry_id: HOLDER_ID } }],
    })

    const result = await stage({ document_id: DOC_ID, journal_entry_id: TARGET_ID, copy: true }, supabase)

    expect(result.staged).toBe(true)
    expect((findCall('pending_operations', 'insert')![0] as Inserted).params).toMatchObject({ copy: true })
    // The shared-document warning says only one verifikat can get it: not so for a copy.
    expect(result.preview.compliance_warning).toBeUndefined()
  })

  it('links a document nothing else holds itself: copy is only used when it is needed', async () => {
    const { supabase, findCall } = copySetup({})

    await stage({ document_id: DOC_ID, journal_entry_id: TARGET_ID, copy: true }, supabase)

    const inserted = findCall('pending_operations', 'insert')![0] as Inserted
    expect(inserted.params).not.toHaveProperty('copy')
    expect(inserted.title).toBe('Koppla bilaga: kontoutdrag.pdf → verifikat D8')
  })

  it('still refuses a copy into a locked year, and a line change on the same verifikat', async () => {
    const locked = copySetup({ docJournalEntryId: HOLDER_ID, period: { ...OPEN_2026, locked_at: '2026-09-20T10:00:00Z' } })
    const lockedError = toToolError(await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID, copy: true }, locked.supabase)).error
    expect(lockedError.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(locked.findCall('pending_operations', 'insert')).toBeUndefined()

    const { supabase } = createTableMockSupabase({
      document_attachments: {
        data: { id: DOC_ID, file_name: 'kontoutdrag.pdf', mime_type: 'application/pdf', journal_entry_id: TARGET_ID, journal_entry_line_id: 'line-a' },
      },
      journal_entries: [{ data: TARGET }, { data: HOLDER }],
      journal_entry_lines: { data: { id: 'line-b' } },
      fiscal_periods: { data: OPEN_2026 },
      pending_operations: [{ data: [] }],
    })
    const lineError = toToolError(
      await refusal({ document_id: DOC_ID, journal_entry_id: TARGET_ID, journal_entry_line_id: 'line-b', copy: true }, supabase),
    ).error
    expect(lineError.code).toBe('DOC_LINK_ALREADY_LINKED')
    expect(lineError.message_en).toContain('journal_entry_line_id cannot change')
  })

  it('declares copy as a boolean on the input schema', () => {
    const props = (linkDocument.inputSchema as { properties: Record<string, { type: string }> }).properties
    expect(props.copy.type).toBe('boolean')
  })
})

describe('gnubok_link_document_to_voucher: pointing at the bulk tool (crm#1207)', () => {
  type Staged = { staged: boolean; next?: { tool?: string; description: string } }
  const waitingLink = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000050${n}`,
    operation_type: 'link_document_to_voucher',
    params: { document_id: `00000000-0000-4000-8000-00000000060${n}`, journal_entry_id: `00000000-0000-4000-8000-00000000070${n}` },
  })
  const stageLink = (supabase: unknown) =>
    linkDocument.execute({ document_id: DOC_ID, journal_entry_id: TARGET_ID }, COMPANY_ID, USER_ID, supabase as never, ACTOR) as Promise<Staged>

  it('names gnubok_link_documents_to_vouchers when two single links already wait: this is the third', async () => {
    const result = await stageLink(setup({ pending: [waitingLink(1), waitingLink(2)] }).supabase)

    expect(result.staged).toBe(true)
    expect(result.next?.tool).toBe('gnubok_link_documents_to_vouchers')
    expect(result.next?.description).toMatch(/^3 single document links are waiting/)
    expect(result.next?.description).toContain('gnubok_stage_tool')
  })

  it('repeats it every tenth link, not on every call', async () => {
    const waiting = (n: number) => Array.from({ length: n }, (_, i) => ({ ...waitingLink(1), id: `op-waiting-${i}` }))
    expect((await stageLink(setup({ pending: waiting(3) }).supabase)).next).toBeUndefined()
    expect((await stageLink(setup({ pending: waiting(12) }).supabase)).next?.description).toMatch(/^13 single document links/)
  })

  it('says nothing for a lone link, or when the waiting proposals are other kinds', async () => {
    expect((await stageLink(setup({ pending: [waitingLink(1)] }).supabase)).next).toBeUndefined()
    const bulk = { ...waitingLink(2), operation_type: 'link_documents_to_vouchers', params: { links: [] } }
    expect((await stageLink(setup({ pending: [bulk, { ...bulk, id: '00000000-0000-4000-8000-000000000509' }] }).supabase)).next).toBeUndefined()
  })

  it('a waiting copy row of the document for another verifikat is no conflict: the copy never holds the document', async () => {
    const { supabase, findCall } = setup({
      pending: [{ id: '00000000-0000-4000-8000-000000000508', params: { links: [{ document_id: DOC_ID, journal_entry_id: HOLDER_ID, copy: true }] } }],
    })

    const result = await stageLink(supabase)

    expect(result.staged).toBe(true)
    expect(findCall('pending_operations', 'insert')).toBeDefined()
  })

  it('the description names the bulk tool and stays within 280 characters', () => {
    expect(linkDocument.description).toContain('gnubok_link_documents_to_vouchers')
    expect(linkDocument.description.length).toBeLessThanOrEqual(280)
    expect(linkDocuments.description.length).toBeLessThanOrEqual(280)
  })
})

describe('gnubok_link_documents_to_vouchers: a document on another verifikat of any status', () => {
  function bulkSetup(holderId: string | null, pending: Array<{ id: string; params: Record<string, unknown> }> = []) {
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
      pending_operations: [{ data: pending }, { data: { id: 'op-1' } }], // the claims read; then the insert
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

  it('previews a document another waiting proposal links elsewhere as proposed_elsewhere and stages only the rest (crm#1158)', async () => {
    const otherOp = '00000000-0000-4000-8000-000000000401'
    const { supabase, findCall } = bulkSetup(null, [
      { id: otherOp, params: { document_id: DOC_ID, journal_entry_id: HOLDER_ID } },
    ])

    const result = (await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as {
      staged: boolean
      preview: { results: Array<{ status: string; conflicting_operation_id?: string }>; matched_count: number; missed_count: number }
    }

    expect(result.staged).toBe(true)
    expect(result.preview.results.map((r) => r.status)).toEqual(['proposed_elsewhere', 'matched'])
    expect(result.preview.results[0]).toMatchObject({ conflicting_operation_id: otherOp })
    expect(result.preview).toMatchObject({ matched_count: 1, missed_count: 1 })
    const inserted = findCall('pending_operations', 'insert')![0] as { params: { links: Array<{ document_id: string }> } }
    expect(inserted.params.links.map((l) => l.document_id)).toEqual(['00000000-0000-4000-8000-000000000102'])
  })

  it('stages a row a waiting proposal already links to the same verifikat', async () => {
    const { supabase } = bulkSetup(null, [
      { id: '00000000-0000-4000-8000-000000000401', params: { document_id: DOC_ID, journal_entry_id: TARGET_ID } },
    ])

    const result = (await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as {
      preview: { results: Array<{ status: string }> }
    }

    expect(result.preview.results.map((r) => r.status)).toEqual(['matched', 'matched'])
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
      pending_operations: [{ data: [] }, { data: { id: 'op-1' } }], // no waiting link proposal; then the insert
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
