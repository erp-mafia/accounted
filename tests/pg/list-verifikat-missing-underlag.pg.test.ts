import { randomUUID } from 'crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  seedCompany,
  insertCashAccount,
  insertDraftJournalEntry,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertBalancedLines,
} from './fixtures'
import { orderByShownAmount, shownAmounts } from './shown-amount-order'
import { missingUnderlagOrder, type JournalListSortKey } from '@/lib/bookkeeping/missing-underlag'
import { VOUCHER_SHAPES, type ShapeLine } from '@/lib/bookkeeping/__tests__/voucher-display-amount.shapes'

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
 *   - an amount sort orders by the amount the list shows: read for the whole
 *     set in one pass (verifikat_display_amounts, 20261125143100), its pages
 *     follow voucherDisplayAmount with the list's other keys for every sort
 *     and filter the list sends, and display_amount, the per-row column it
 *     read before, is gone;
 *   - the order allowlist refuses anything else, and the tenant guard refuses
 *     a company the caller is no member of; another company's verifikat and
 *     cash accounts never reach an amount sort;
 *   - a document or a waiver of another company backs nothing, in both
 *     functions (20261023093920, 20261023093930).
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

/** As the company's member, the way the list calls it. */
async function listAs(userId: string, p: ListParams): Promise<ListResult> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ r: ListResult }>(LIST_SQL, listArgs(p))
    return rows[0].r
  })
}

/** The RPC's order tokens for a sort stack, as the list route sends them. */
function orderTokens(sort: JournalListSortKey[]): string[] {
  return missingUnderlagOrder(sort, null).map((t) => `${t.column}.${t.ascending ? 'asc' : 'desc'}`)
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

  it("treats another company's document or waiver as no underlag, in both functions", async () => {
    // 20261023093920 and 20261023093930: a file or a waiver of another
    // company is not this company's underlag. a1 and a2 stay missing, so the
    // totals the other cases expect are unchanged.
    const other = await seedCompany()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, journal_entry_id, file_name, mime_type,
          file_size_bytes, storage_path, sha256_hash, upload_source)
       VALUES ($1, $2, $3, $4, 'annat-bolag.pdf', 'application/pdf', 1024, $5, $6, 'file_upload')`,
      [
        randomUUID(),
        other.userId,
        other.companyId,
        a1,
        `documents/${other.companyId}/annat-bolag.pdf`,
        randomUUID().replace(/-/g, '').padEnd(64, '0'),
      ],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_no_doc_required (journal_entry_id, company_id, user_id, reason)
       VALUES ($1, $2, $3, 'annat bolag')`,
      [a2, other.companyId, other.userId],
    )

    const res = await list({ companyId })
    const badge = await badgeSet(companyId)
    expect(res.ids).toEqual(expect.arrayContaining([a1, a2]))
    expect(badge.ids).toEqual(expect.arrayContaining([a1, a2]))
    expect([...(res.ids ?? [])].sort()).toEqual([...badge.ids].sort())
    expect(res.total_count).toBe(4)
    expect(badge.total).toBe(4)
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

  it('orders an amount sort by the amount the list shows', async () => {
    // As the member, as the list calls it.
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

describe('list_verifikat_missing_underlag sorted by Belopp', () => {
  let userId: string
  let companyId: string
  let y2026: string
  let y2025: string
  let otherUserId: string
  let otherCompanyId: string
  // This company's verifikat that lack underlag, by name.
  const v: Record<string, string> = {}
  // Its verifikat that do not, and the other company's: never in the set.
  const excluded: string[] = []
  const foreign: Record<string, string> = {}

  const shape = (name: string): ShapeLine[] => {
    const found = VOUCHER_SHAPES.find((s) => s.name === name)
    if (!found) throw new Error(`no voucher shape named ${name}`)
    return found.lines
  }
  const toLines = (lines: ShapeLine[]) =>
    lines.map(([accountNumber, debit, credit]) => ({
      accountNumber,
      debitAmount: Number(debit),
      creditAmount: Number(credit),
    }))
  // A reverse-charge payment from a balance on 1687: Belopp 200 where 1687 is
  // a money account of the company, else its omslutning, 250.
  const FROM_1687: ShapeLine[] = [
    ['2645', 50, 0],
    ['2614', 0, 50],
    ['6540', 200, 0],
    ['1687', 0, 200],
  ]
  const purchase = (amount: number): ShapeLine[] => [
    ['5410', amount, 0],
    ['1930', 0, amount],
  ]

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    y2026 = s.fiscalPeriodId
    y2025 = await insertFiscalPeriod({ userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    // A payment provider's balance: 1686 is a money account of this company.
    await insertCashAccount({ companyId, ledgerAccount: '1686', source: 'manual' })

    const other = await seedCompany()
    otherUserId = other.userId
    otherCompanyId = other.companyId
    // 1687 is a money account of the other company only.
    await insertCashAccount({ companyId: otherCompanyId, ledgerAccount: '1687', source: 'manual' })

    const entry = (p: {
      periodId?: string
      series?: string
      number: number
      date: string
      description: string
      lines: ShapeLine[]
      sourceType?: string
    }) =>
      insertPostedJournalEntry({
        userId,
        companyId,
        fiscalPeriodId: p.periodId ?? y2026,
        voucherSeries: p.series ?? 'A',
        voucherNumber: p.number,
        entryDate: p.date,
        description: p.description,
        sourceType: p.sourceType ?? 'manual',
        lines: toLines(p.lines),
      })

    // The Belopp differs from the omslutning on most of these, and several
    // share a Belopp, a description or a voucher label, so a sort by the
    // omslutning, by another company's cash accounts or with a broken
    // tiebreak reads in another order.
    const rc = shape('reverse-charge bank payment') // 200, omslutning 450
    v.rc2026A1 = await entry({ number: 1, date: '2026-03-01', description: 'Programvara', lines: rc })
    v.provider = await entry({
      number: 2, date: '2026-03-01', description: 'Leverantör',
      lines: shape('payment from a provider balance kept as a cash account'), // 200 on 1686, omslutning 250
    })
    v.rc2026B1 = await entry({ series: 'B', number: 1, date: '2026-03-02', description: 'Programvara', lines: rc })
    v.salary = await entry({
      number: 3, date: '2026-04-25', description: 'Lön april',
      lines: shape('salary payment (net pay left the bank)'), // 23 000, omslutning 39 426
    })
    v.card = await entry({
      number: 4, date: '2026-04-30', description: 'Kortutbetalning',
      lines: shape('card payout (receivable on the opposite side)'), // 970, omslutning 1 000
    })
    v.accrual = await entry({
      number: 5, date: '2026-05-02', description: 'Periodisering',
      lines: shape('manual voucher without a money line'), // 250
    })
    v.transfer = await entry({
      number: 6, date: '2026-05-02', description: 'Överföring',
      lines: shape('transfer between two 19xx accounts'), // 5 000
    })
    v.ore = await entry({
      number: 7, date: '2026-05-03', description: 'Öresbelopp',
      lines: shape('öre amounts as numeric strings'), // 0,20, omslutning 0,30
    })
    // 1687 is no money account of this company: the omslutning, 250.
    v.from1687 = await entry({ number: 8, date: '2026-06-01', description: 'Programvara', lines: FROM_1687 })
    // The earlier year: the same label as the first, A1, and the same Belopp.
    v.rc2025A1 = await entry({ periodId: y2025, number: 1, date: '2025-03-01', description: 'Programvara', lines: rc })
    v.sale2025 = await entry({
      periodId: y2025, number: 2, date: '2025-11-30', description: 'Försäljning',
      lines: shape('plain sale paid to the bank'), // 1 250
    })

    // Not missing, each with an amount that would top a Belopp sort.
    const withDoc = await entry({ number: 9, date: '2026-06-02', description: 'Programvara med kvitto', lines: purchase(99999) })
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
    const waived = await entry({ number: 10, date: '2026-06-03', description: 'Programvara intern', lines: purchase(88888) })
    await getPool().query(
      `INSERT INTO public.journal_entry_no_doc_required (journal_entry_id, company_id, user_id, reason)
       VALUES ($1, $2, $3, 'internal transfer')`,
      [waived, companyId, userId],
    )
    const invoiced = await entry({
      number: 11, date: '2026-06-04', description: 'Programvara faktura', sourceType: 'invoice_created',
      lines: [['1510', 77777, 0], ['3001', 0, 77777]],
    })
    const draft = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId: y2026, entryDate: '2026-06-05', description: 'Programvara utkast',
    })
    await insertBalancedLines(draft, 66666)
    excluded.push(withDoc, waived, invoiced, draft)

    // The other company: undocumented too, and alike in every filter below.
    const theirs = (p: { series?: string; number: number; date: string; lines: ShapeLine[] }) =>
      insertPostedJournalEntry({
        userId: other.userId,
        companyId: other.companyId,
        fiscalPeriodId: other.fiscalPeriodId,
        voucherSeries: p.series ?? 'A',
        voucherNumber: p.number,
        entryDate: p.date,
        description: 'Programvara',
        lines: toLines(p.lines),
      })
    foreign.big = await theirs({ number: 1, date: '2026-03-01', lines: purchase(1000000) })
    foreign.mid = await theirs({ number: 2, date: '2026-03-02', lines: purchase(225) })
    // 1687 is this company's money account: Belopp 200, below the 225.
    foreign.from1687 = await theirs({ series: 'B', number: 1, date: '2026-03-02', lines: FROM_1687 })
  })

  it('orders every year by the amount on screen, not the omslutning, with the voucher and id tiebreaks', async () => {
    const res = await listAs(userId, { companyId, order: orderTokens([{ column: 'total', ascending: false }]) })
    expect(res.ok).toBe(true)
    const ids = res.ids ?? []
    expect(ids.slice(0, 4)).toEqual([v.salary, v.transfer, v.sale2025, v.card])
    // 250: the later voucher number first.
    expect(ids.slice(4, 6)).toEqual([v.from1687, v.accrual])
    // 200: series B before A, A2 before A1, and the two A1 of two years by id.
    expect(ids.slice(6, 8)).toEqual([v.rc2026B1, v.provider])
    expect([...ids.slice(8, 10)].sort()).toEqual([v.rc2026A1, v.rc2025A1].sort())
    expect(ids.slice(10)).toEqual([v.ore])
    expect(res.total_count).toBe(11)
  })

  it('pages every sort the list sends, under every filter, in the order the amounts on screen give', async () => {
    // What the list sends for a Belopp sort (missingUnderlagOrder) and the
    // filters as listMissingUnderlagPage passes them: a needle is a pattern,
    // and a voucher label also matches series + number.
    const sorts: JournalListSortKey[][] = [
      [{ column: 'total', ascending: false }],
      [{ column: 'total', ascending: true }],
      [{ column: 'total', ascending: false }, { column: 'description', ascending: true }],
      [{ column: 'voucher', ascending: true }, { column: 'total', ascending: false }],
      [{ column: 'date', ascending: false }, { column: 'total', ascending: true }],
      [{ column: 'description', ascending: true }, { column: 'total', ascending: false }],
    ]
    const filters: Array<[string, Omit<ListParams, 'companyId'>]> = [
      ['every year', {}],
      ['one fiscal year', { periodId: y2026 }],
      ['a series', { series: 'B' }],
      ['a date range', { dateFrom: '2026-03-01', dateTo: '2026-04-30' }],
      ['a text', { searchPattern: '%programvara%' }],
      ['a voucher label', { searchPattern: '%A1%', searchVoucherSeries: 'A', searchVoucherNumber: 1 }],
    ]
    const amounts = await shownAmounts(userId, companyId)
    const own = new Set(Object.values(v))

    let pages = 0
    for (const [filterName, filter] of filters) {
      const set = await listAs(userId, { companyId, ...filter, order: ['id.asc'] })
      expect(set.ok).toBe(true)
      const ids = set.ids ?? []
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect({ filterName, own: own.has(id) }).toEqual({ filterName, own: true })
      if (filterName === 'every year') expect([...ids].sort()).toEqual([...own].sort())

      for (const sort of sorts) {
        const order = orderTokens(sort)
        const expected = await orderByShownAmount(ids, amounts, order)
        const paged: string[] = []
        for (let offset = 0; offset < ids.length + 2; offset += 2) {
          const page = await listAs(userId, { companyId, ...filter, order, limit: 2, offset })
          expect(page.ok).toBe(true)
          expect(page.total_count).toBe(ids.length)
          paged.push(...(page.ids ?? []))
          pages += 1
        }
        expect({ filterName, order, paged }).toEqual({ filterName, order, paged: expected })
      }
    }
    expect(pages).toBeGreaterThan(100)
  })

  it("never returns another company's verifikat or reads its cash accounts, and refuses its company", async () => {
    const order = orderTokens([{ column: 'total', ascending: false }])
    const mine = await listAs(userId, { companyId, order, searchPattern: '%programvara%' })
    expect(mine.ok).toBe(true)
    for (const id of [...Object.values(foreign), ...excluded]) expect(mine.ids).not.toContain(id)
    // 1687 is the other company's money account, not this one's: the
    // verifikat shows its omslutning, 250, above its three 200s.
    expect(mine.ids?.[0]).toBe(v.from1687)
    expect([...(mine.ids ?? [])].sort()).toEqual([v.from1687, v.rc2026B1, v.rc2026A1, v.rc2025A1].sort())

    // The other company's member sees its own, its 1687 line as money.
    const theirs = await listAs(otherUserId, { companyId: otherCompanyId, order, searchPattern: '%programvara%' })
    expect(theirs).toEqual({ ok: true, total_count: 3, ids: [foreign.big, foreign.mid, foreign.from1687] })

    const refused = await listAs(userId, { companyId: otherCompanyId, order })
    expect(refused).toEqual({ ok: false, code: 'LIST_VERIFIKAT_MISSING_UNDERLAG_FORBIDDEN' })
  })

  it('reads the amounts through the set function: display_amount, the per-row column, is gone', async () => {
    const { rows } = await getPool().query<{ per_row: boolean; set: boolean }>(
      `SELECT to_regprocedure('public.display_amount(public.journal_entries)') IS NOT NULL AS per_row,
              to_regprocedure('public.verifikat_display_amounts(uuid, uuid[])') IS NOT NULL AS set`,
    )
    expect(rows[0]).toEqual({ per_row: false, set: true })
  })
})
