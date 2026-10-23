import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertBalancedLines,
} from './fixtures'

/**
 * list_verifikat_missing_underlag (migration 20261023001000, crm#1390): the
 * verifikat list's "saknar underlag" filter resolved, sorted and paged in one
 * statement. Pins, on real Postgres:
 *   - the set is the verifikat_without_documents set (all years, no filters);
 *     the fixture matrices of document-surfaces-unification and
 *     underlag-customer-invoice-reference pin the same parity arm by arm;
 *   - the list's filters narrow it: fiscal year, series, date range, the
 *     description search (case-insensitive, escaped pattern) and a voucher
 *     label matching series + number;
 *   - total_count spans every page, and consecutive pages are disjoint and
 *     complete in the requested order;
 *   - an amount sort orders by display_amount, the amount the list shows;
 *   - the order allowlist refuses anything else, and the tenant guard refuses
 *     a company the caller is no member of.
 */

type ListResult = { ok: boolean; code?: string; total_count?: number; ids?: string[] }

interface ListParams {
  companyId: string
  periodId?: string | null
  series?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  searchPattern?: string | null
  searchVoucherSeries?: string | null
  searchVoucherNumber?: number | null
  order?: string[] | null
  limit?: number
  offset?: number
}

const LIST_SQL = `SELECT public.list_verifikat_missing_underlag(
  $1::uuid, $2::uuid, $3::text, $4::date, $5::date, $6::text, $7::text, $8::integer,
  $9::text[], $10::integer, $11::integer) AS r`

function listArgs(p: ListParams): unknown[] {
  return [
    p.companyId,
    p.periodId ?? null,
    p.series ?? null,
    p.dateFrom ?? null,
    p.dateTo ?? null,
    p.searchPattern ?? null,
    p.searchVoucherSeries ?? null,
    p.searchVoucherNumber ?? null,
    p.order ?? null,
    p.limit ?? 1000,
    p.offset ?? 0,
  ]
}

async function list(p: ListParams): Promise<ListResult> {
  const { rows } = await getPool().query<{ r: ListResult }>(LIST_SQL, listArgs(p))
  return rows[0].r
}

async function badgeSet(companyId: string): Promise<{ total: number; ids: string[] }> {
  const { rows } = await getPool().query<{
    r: { ok: boolean; total_count: number; verifikat: { journal_entry_id: string }[] }
  }>(`SELECT public.verifikat_without_documents($1, NULL, 0, 100, 0) AS r`, [companyId])
  expect(rows[0].r.ok).toBe(true)
  return { total: rows[0].r.total_count, ids: rows[0].r.verifikat.map((v) => v.journal_entry_id) }
}

describe('list_verifikat_missing_underlag', () => {
  let userId: string
  let companyId: string
  let period2026: string
  let period2025: string
  // Missing underlag (manual, no document, no waiver):
  let a1: string // 2026-03-01, A1, 100 kr
  let a2: string // 2026-03-02, A2, 900 kr
  let b1: string // 2026-04-01, B1, 300 kr
  let old1: string // 2025-06-01, A1 of the earlier year, 500 kr
  // Not missing:
  let withDoc: string
  let waived: string
  let docExempt: string // invoice_created: not a needs-doc source type
  let draft: string
  let foreign: string // another company's undocumented entry

  const purchase = (amount: number) => [
    { accountNumber: '5410', debitAmount: amount, creditAmount: 0 },
    { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
  ]

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    period2026 = s.fiscalPeriodId
    period2025 = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })

    const entry = (p: {
      periodId: string
      series?: string
      number: number
      date: string
      description: string
      amount: number
      sourceType?: string
    }) =>
      insertPostedJournalEntry({
        userId,
        companyId,
        fiscalPeriodId: p.periodId,
        voucherSeries: p.series ?? 'A',
        voucherNumber: p.number,
        entryDate: p.date,
        description: p.description,
        sourceType: p.sourceType ?? 'manual',
        lines: purchase(p.amount),
      })

    a1 = await entry({ periodId: period2026, number: 1, date: '2026-03-01', description: 'Kontorsmaterial', amount: 100 })
    a2 = await entry({ periodId: period2026, number: 2, date: '2026-03-02', description: 'Hyra mars', amount: 900 })
    b1 = await entry({ periodId: period2026, series: 'B', number: 1, date: '2026-04-01', description: 'Bensin', amount: 300 })
    old1 = await entry({ periodId: period2025, number: 1, date: '2025-06-01', description: 'Gammal HYRA', amount: 500 })

    withDoc = await entry({ periodId: period2026, number: 3, date: '2026-05-01', description: 'Med kvitto', amount: 200 })
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, journal_entry_id, file_name, mime_type,
          file_size_bytes, storage_path, sha256_hash, upload_source)
       VALUES ($1, $2, $3, $4, 'kvitto.pdf', 'application/pdf', 1024, $5, $6, 'file_upload')`,
      [
        randomUUID(),
        userId,
        companyId,
        withDoc,
        `documents/${companyId}/kvitto.pdf`,
        randomUUID().replace(/-/g, '').padEnd(64, '0'),
      ],
    )
    waived = await entry({ periodId: period2026, number: 4, date: '2026-05-02', description: 'Intern flytt', amount: 250 })
    await getPool().query(
      `INSERT INTO public.journal_entry_no_doc_required (journal_entry_id, company_id, user_id, reason)
       VALUES ($1, $2, $3, 'internal transfer')`,
      [waived, companyId, userId],
    )
    docExempt = await entry({
      periodId: period2026,
      number: 5,
      date: '2026-05-03',
      description: 'Faktura',
      amount: 400,
      sourceType: 'invoice_created',
    })
    draft = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: period2026,
      voucherNumber: 0,
      entryDate: '2026-05-04',
      description: 'Utkast',
    })
    await insertBalancedLines(draft, 50)

    const other = await seedCompany()
    foreign = await insertPostedJournalEntry({
      userId: other.userId,
      companyId: other.companyId,
      fiscalPeriodId: other.fiscalPeriodId,
      voucherNumber: 1,
      entryDate: '2026-03-01',
      description: 'Hyra mars',
      lines: purchase(900),
    })
  })

  it('is the verifikat_without_documents set across all years', async () => {
    const res = await list({ companyId })
    expect(res.ok).toBe(true)
    const badge = await badgeSet(companyId)
    expect([...(res.ids ?? [])].sort()).toEqual([...badge.ids].sort())
    expect(res.total_count).toBe(badge.total)
    expect([...(res.ids ?? [])].sort()).toEqual([a1, a2, b1, old1].sort())
    for (const excluded of [withDoc, waived, docExempt, draft, foreign]) {
      expect(res.ids).not.toContain(excluded)
    }
  })

  it('narrows by fiscal year, series and date range', async () => {
    const byYear = await list({ companyId, periodId: period2026 })
    expect([...(byYear.ids ?? [])].sort()).toEqual([a1, a2, b1].sort())
    expect(byYear.total_count).toBe(3)

    const bySeries = await list({ companyId, series: 'B' })
    expect(bySeries.ids).toEqual([b1])

    const byDates = await list({ companyId, dateFrom: '2026-03-01', dateTo: '2026-03-31' })
    expect([...(byDates.ids ?? [])].sort()).toEqual([a1, a2].sort())
  })

  it('searches the description case-insensitively and a voucher label by series + number', async () => {
    const byText = await list({ companyId, searchPattern: '%hyra%' })
    expect([...(byText.ids ?? [])].sort()).toEqual([a2, old1].sort())

    // "A2": no description contains it, the label matches A2 itself. The
    // earlier year has no A2, so exactly one row.
    const byLabel = await list({
      companyId,
      searchPattern: '%A2%',
      searchVoucherSeries: 'A',
      searchVoucherNumber: 2,
    })
    expect(byLabel.ids).toEqual([a2])

    // "A1" recurs once per räkenskapsår: both years' A1, narrowed by year.
    const label = { searchPattern: '%A1%', searchVoucherSeries: 'A', searchVoucherNumber: 1 }
    const allYears = await list({ companyId, ...label })
    expect([...(allYears.ids ?? [])].sort()).toEqual([a1, old1].sort())
    const oneYear = await list({ companyId, periodId: period2025, ...label })
    expect(oneYear.ids).toEqual([old1])
  })

  it('orders as asked and pages disjointly with the full total on every page', async () => {
    const order = ['entry_date.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc']
    const pages: string[][] = []
    for (let offset = 0; offset < 4; offset += 2) {
      const res = await list({ companyId, order, limit: 2, offset })
      expect(res.ok).toBe(true)
      expect(res.total_count).toBe(4)
      pages.push(res.ids ?? [])
    }
    expect(pages).toEqual([
      [b1, a2],
      [a1, old1],
    ])
    const beyond = await list({ companyId, order, limit: 2, offset: 4 })
    expect(beyond.ids).toEqual([])
    expect(beyond.total_count).toBe(4)

    const voucherAsc = await list({
      companyId,
      periodId: period2026,
      order: ['voucher_series.asc', 'voucher_number.asc', 'id.asc'],
    })
    expect(voucherAsc.ids).toEqual([a1, a2, b1])
  })

  it('clamps the page size to at least one row', async () => {
    const res = await list({ companyId, limit: 0 })
    expect(res.ids).toHaveLength(1)
    expect(res.total_count).toBe(4)
  })

  it('orders an amount sort by display_amount, the amount the list shows', async () => {
    // display_amount answers only for an entry the caller may read, so the
    // amount sort runs as the member, as the list does.
    const res = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ r: ListResult }>(
        LIST_SQL,
        listArgs({ companyId, order: ['display_amount.desc', 'id.desc'] }),
      )
      return rows[0].r
    })
    expect(res.ok).toBe(true)
    expect(res.ids).toEqual([a2, old1, b1, a1])
  })

  it('refuses an order token outside the allowlist', async () => {
    const res = await list({ companyId, order: ['entry_date.desc', 'description; drop table x'] })
    expect(res).toEqual({ ok: false, code: 'LIST_VERIFIKAT_MISSING_UNDERLAG_INVALID_ORDER' })
  })

  it("refuses a company the caller is no member of, answers the caller's own", async () => {
    const other = await seedCompany()
    const [foreignRes, ownRes] = await withUserContext(userId, async (client) => {
      const a = await client.query<{ r: ListResult }>(LIST_SQL, listArgs({ companyId: other.companyId }))
      const b = await client.query<{ r: ListResult }>(LIST_SQL, listArgs({ companyId }))
      return [a.rows[0].r, b.rows[0].r]
    })
    expect(foreignRes).toEqual({ ok: false, code: 'LIST_VERIFIKAT_MISSING_UNDERLAG_FORBIDDEN' })
    expect(ownRes.ok).toBe(true)
    expect(ownRes.total_count).toBe(4)
  })

  it('is not executable by anon', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean }>(
      `SELECT
         has_function_privilege('anon', 'public.list_verifikat_missing_underlag(uuid, uuid, text, date, date, text, text, integer, text[], integer, integer)', 'EXECUTE') AS anon,
         has_function_privilege('authenticated', 'public.list_verifikat_missing_underlag(uuid, uuid, text, date, date, text, text, integer, text[], integer, integer)', 'EXECUTE') AS authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true })
  })
})
