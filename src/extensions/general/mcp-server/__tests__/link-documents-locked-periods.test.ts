/**
 * gnubok_link_documents_to_vouchers previews a row whose verifikat sits in a
 * closed or locked fiscal period as period_locked and never stages it:
 * enforce_period_lock_documents (migration 20240101000017) refuses that link,
 * so staging it only moved the refusal to approval. Feedback seq 754875: a
 * Bokio receipt migration previewed 142 of 142 as matched into years that had
 * been klarmarkerade 30 minutes earlier, and approval linked none of them.
 *
 * Also: gnubok_list_verifikat_without_documents names the tool that writes a
 * waiver (feedback seq 706722: an agent guessed six tool names).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools, isStagingTool } from '../server'
import { toToolError } from '../tool-result'
import { projectToolReferences } from '../tool-namespace'

const linkDocuments = tools.find((t) => t.name === 'gnubok_link_documents_to_vouchers')!
const listVerifikat = tools.find((t) => t.name === 'gnubok_list_verifikat_without_documents')!

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ACTOR = { type: 'api_key' as const }

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function period(year: number, state: Record<string, unknown> = {}) {
  return {
    id: `fp-${year}`,
    period_start: `${year}-01-01`,
    period_end: `${year}-12-31`,
    is_closed: false,
    locked_at: null,
    closed_externally: false,
    closing_entry_id: null,
    ...state,
  }
}

// Klarmarkera closes and locks in one step: prod held 2021 to 2025 this way
// for the company in feedback seq 754875.
const KLARMARKERAT = { is_closed: true, locked_at: '2026-09-26T08:33:14Z', closed_externally: true }
const LOCKED = { locked_at: '2026-09-20T10:00:00Z' }
const YEAR_END_CLOSED = { is_closed: true, locked_at: '2026-03-01T10:00:00Z', closing_entry_id: uuid(999) }

/** One receipt per row, each for posted verifikat A<n> in the named year. */
function setup(rows: Array<{ n: number; year: number }>, periods: Array<ReturnType<typeof period>>) {
  const mock = createTableMockSupabase({
    fiscal_periods: { data: periods },
    document_attachments: {
      data: rows.map((r) => ({
        id: uuid(100 + r.n),
        file_name: `${r.year}_V${r.n}.pdf`,
        mime_type: 'application/pdf',
        journal_entry_id: null,
      })),
    },
    journal_entries: {
      data: rows.map((r) => ({
        id: uuid(200 + r.n),
        entry_date: `${r.year}-03-15`,
        description: 'Kvitto',
        voucher_series: 'A',
        voucher_number: r.n,
        status: 'posted',
        fiscal_period_id: `fp-${r.year}`,
      })),
    },
    pending_operations: { data: { id: 'op-1' } },
  })
  const links = rows.map((r) => ({
    document_id: uuid(100 + r.n),
    voucher_series: 'A',
    voucher_number: r.n,
    fiscal_year: r.year,
  }))
  return { ...mock, links }
}

type Staged = { staged: boolean; preview: Record<string, unknown> }
type Inserted = { title: string; params: { links: Array<{ document_id: string; journal_entry_id: string }> } }

async function refusal(links: unknown[], supabase: unknown) {
  return linkDocuments
    .execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)
    .then(() => null, (err: unknown) => err)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_link_documents_to_vouchers: rows in locked or closed periods', () => {
  it('stages only the open-period rows of a mixed batch and reports the rest as period_locked', async () => {
    const { supabase, findCall, links } = setup(
      [{ n: 1, year: 2026 }, { n: 2, year: 2026 }, { n: 3, year: 2023 }],
      [period(2026), period(2023, KLARMARKERAT)],
    )

    const result = (await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as Staged

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')![0] as Inserted
    expect(inserted.params.links.map((l) => l.journal_entry_id)).toEqual([uuid(201), uuid(202)])
    expect(inserted.title).toBe('Koppla 2 bilagor till verifikat (1 i låst period)')
    expect(result.preview).toMatchObject({
      total: 3,
      matched_count: 2,
      missed_count: 1,
      period_locked_count: 1,
      locked_periods: [
        {
          fiscal_period_id: 'fp-2023',
          fiscal_year: 2023,
          status: 'closed',
          row_count: 1,
          reopen_tool: 'gnubok_reopen_fiscal_period_external',
        },
      ],
    })
    const results = result.preview.results as Array<Record<string, unknown>>
    expect(results.map((r) => r.status)).toEqual(['matched', 'matched', 'period_locked'])
    // The locked row still names its verifikat, so the caller can see exactly what was left out.
    expect(results[2]).toMatchObject({ journal_entry_id: uuid(203), voucher_label: 'A3', voucher_date: '2023-03-15' })
  })

  it('refuses at staging when every row sits in a klarmarkerat year, naming the reopen tool (feedback seq 754875)', async () => {
    const { supabase, findCall, links } = setup(
      [{ n: 1, year: 2022 }, { n: 2, year: 2023 }, { n: 3, year: 2023 }],
      [period(2022, KLARMARKERAT), period(2023, KLARMARKERAT), period(2026)],
    )

    const err = await refusal(links, supabase)

    expect(findCall('pending_operations', 'insert')).toBeUndefined()
    const { error } = toToolError(err)
    expect(error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(error.retryable).toBe(false)
    expect(error.message_sv).toBe('Det går inte att bifoga underlag till verifikationer i en låst eller stängd period.')
    expect(error.message_en).toMatch(/^No links staged: 3 of 3 rows target verifikat in a locked or closed fiscal period/)
    expect(error.message_en).toContain(
      'fiscal_year 2022 (fiscal_period_id fp-2022, 1 row) is marked closed in the previous system: reopen it with gnubok_reopen_fiscal_period_external.',
    )
    expect(error.message_en).toContain('fiscal_year 2023 (fiscal_period_id fp-2023, 2 rows)')
    // Unlocking cannot help a closed year, so the message never points there.
    expect(error.message_en).not.toContain('gnubok_unlock_period')
    expect(error.remediation?.tool).toBe('gnubok_reopen_fiscal_period_external')
    expect(error.remediation?.description).toMatch(/gnubok_reopen_fiscal_period_external.*gnubok_unlock_period/)
    // Two years to reopen: no single fiscal_period_id to prefill.
    expect(error.remediation?.args).toBeUndefined()
  })

  it('names gnubok_unlock_period for a locked year, and no way back for a year closed by a year-end run', async () => {
    const { supabase, links } = setup(
      [{ n: 1, year: 2025 }, { n: 2, year: 2022 }],
      [period(2025, LOCKED), period(2022, YEAR_END_CLOSED)],
    )

    const { error } = toToolError(await refusal(links, supabase))

    expect(error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(error.message_en).toContain(
      'fiscal_year 2025 (fiscal_period_id fp-2025, 1 row) is locked: unlock it with gnubok_unlock_period.',
    )
    expect(error.message_en).toContain(
      'fiscal_year 2022 (fiscal_period_id fp-2022, 1 row) was closed by a year-end run here and cannot be reopened.',
    )
    expect(error.remediation).toMatchObject({ tool: 'gnubok_unlock_period', args: { fiscal_period_id: 'fp-2025' } })
  })

  it('keeps the other misses in the refusal when nothing is left to stage', async () => {
    const { supabase, links } = setup([{ n: 1, year: 2023 }], [period(2023, KLARMARKERAT)])
    const unknownYear = { document_id: uuid(150), voucher_series: 'A', voucher_number: 9, fiscal_year: 2019 }

    const { error } = toToolError(await refusal([...links, unknownYear], supabase))

    expect(error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(error.message_en).toMatch(/^No links staged: 1 of 2 rows/)
    expect(error.message_en).toContain('1 row more did not resolve either; first: {"document_id":"' + uuid(150))
    expect(error.message_en).toContain('"status":"unknown_fiscal_year"')
  })

  it('stages an open-period batch as before', async () => {
    const { supabase, findCall, links } = setup([{ n: 1, year: 2026 }, { n: 2, year: 2026 }], [period(2026)])

    const result = (await linkDocuments.execute({ links }, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as Staged

    expect(result.staged).toBe(true)
    const inserted = findCall('pending_operations', 'insert')![0] as Inserted
    expect(inserted.title).toBe('Koppla 2 bilagor till verifikat')
    expect(inserted.params.links).toEqual([
      { document_id: uuid(101), journal_entry_id: uuid(201), journal_entry_line_id: null },
      { document_id: uuid(102), journal_entry_id: uuid(202), journal_entry_line_id: null },
    ])
    expect(result.preview).toMatchObject({ total: 2, matched_count: 2, missed_count: 0, period_locked_count: 0 })
    expect(result.preview).not.toHaveProperty('locked_periods')
    expect((result.preview.results as Array<{ status: string }>).map((r) => r.status)).toEqual(['matched', 'matched'])
  })
})

describe('gnubok_list_verifikat_without_documents: the waiver tool', () => {
  it('names gnubok_mark_no_document_required, a registered staging write, next to the rows', async () => {
    const { supabase } = createTableMockSupabase({
      'rpc:verifikat_without_documents': { data: { ok: true, total_count: 0, verifikat: [] } },
    })

    const result = (await listVerifikat.execute({}, COMPANY_ID, USER_ID, supabase as never, ACTOR)) as Record<string, unknown>

    expect(result.waiver_tool).toBe('gnubok_mark_no_document_required')
    const waiver = tools.find((t) => t.name === result.waiver_tool)
    expect(waiver, 'the pointer must name a tool that exists, or agents guess again').toBeDefined()
    expect(isStagingTool(waiver!)).toBe(true)
    const declared = (listVerifikat.outputSchema as { properties: Record<string, unknown> }).properties
    expect(declared.waiver_tool).toBeDefined()
  })

  it('reaches accounted_* clients under their own tool name', () => {
    const projected = projectToolReferences(
      { waiver_tool: 'gnubok_mark_no_document_required' },
      'accounted',
      new Set(tools.map((t) => t.name)),
    )
    expect(projected.waiver_tool).toBe('accounted_mark_no_document_required')
  })
})
