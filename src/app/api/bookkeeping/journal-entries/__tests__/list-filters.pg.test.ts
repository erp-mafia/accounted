import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'

// Covers the p_exclude_draft / p_collapse_corrections / p_series params on
// list_fiscal_period_entries_with_related (migrations 20260621130500 +
// 20260629160000).
//   - exclude_draft: drafts kept off the committed list (own "Utkast" surface).
//   - collapse_corrections: a correction group renders as ONE row: the live
//     correction; the storno and the reversed original it replaced are hidden.
//     A pure storno (no correction) stays visible with its original (#3149,
//     migration 20260927201017).
//   - series: voucher-series filter; pushed into the RPC so total_count reflects
//     the filtered set (the route used to post-filter and recompute count from
//     one page, breaking pagination, #798).
// total_count must stay in lockstep with the filtered set so pagination holds.
//
// Migration 20261112100013 rewrote the function to count and sort the keys
// and read the full rows for the page only. The last three tests pin what
// that rewrite must not change: the cross-year payments and their
// out_of_period mark, the page cut with its total, and the row payload.
describe('list_fiscal_period_entries_with_related: draft + correction filters', () => {
  // Insert a journal_entry directly so we can set the storno/correction link
  // columns the fixtures don't expose. Header and balanced lines go in ONE
  // transaction: check_balance_on_posted_insert is deferred to commit, so a
  // posted header committed alone (autocommit per query) is rejected with
  // "has zero total" before the lines could ever land.
  async function insertEntry(p: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    status: 'draft' | 'posted' | 'reversed'
    sourceType: string
    voucherNumber: number
    description: string
    voucherSeries?: string
    entryDate?: string
    reversesId?: string
    correctionOfId?: string
    sourceId?: string
    withLines?: boolean
  }): Promise<string> {
    const id = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status, reverses_id, correction_of_id, source_id)
         VALUES ($1,$2,$3,$4,$5,$11,$12,$6,$7,$8,$9,$10,$13)`,
        [
          id,
          p.userId,
          p.companyId,
          p.fiscalPeriodId,
          p.voucherNumber,
          p.description,
          p.sourceType,
          p.status,
          p.reversesId ?? null,
          p.correctionOfId ?? null,
          p.voucherSeries ?? 'A',
          p.entryDate ?? '2026-06-01',
          p.sourceId ?? null,
        ],
      )
      if (p.withLines) {
        await client.query(
          `INSERT INTO public.journal_entry_lines
             (journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, '1930', 1000, 0),
                  ($1, '3001', 0, 1000)`,
          [id],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
    return id
  }

  async function callRpc(
    companyId: string,
    periodId: string,
    opts: {
      status?: string | null
      excludeDraft?: boolean
      collapse?: boolean
      series?: string | null
      limit?: number
      offset?: number
      sortDate?: 'asc' | 'desc'
      includeRelated?: boolean
    } = {},
  ) {
    const { rows } = await getPool().query<{
      entry: {
        id: string
        voucher_series: string
        voucher_number: number
        description: string
        status: string
        out_of_period: boolean
        lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
      }
      total_count: string
    }>(
      `SELECT entry, total_count
         FROM list_fiscal_period_entries_with_related(
           $1, $2, $10, $3, NULL, NULL, $8, $6, $9, $4, $5, $7)`,
      [
        companyId,
        periodId,
        opts.status ?? null,
        opts.excludeDraft ?? false,
        opts.collapse ?? false,
        opts.limit ?? 100,
        opts.series ?? null,
        opts.sortDate ?? 'desc',
        opts.offset ?? 0,
        opts.includeRelated ?? true,
      ],
    )
    return rows
  }

  it('excludes drafts and collapses a correction group to the live correction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const posted = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: 10, withLines: true, description: 'Plain posted' })
    const draft = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'draft', sourceType: 'manual', voucherNumber: 0, description: 'Draft' })
    // Correction group: original is reversed; storno reverses it; correction replaces it.
    const original = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'reversed', sourceType: 'manual', voucherNumber: 11, withLines: true, description: 'Original' })
    const storno = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'storno', voucherNumber: 12, reversesId: original, withLines: true, description: 'Storno' })
    const correction = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'correction', voucherNumber: 13, correctionOfId: original, withLines: true, description: 'Correction' })

    // Default (no filters): every row shows.
    const all = await callRpc(companyId, fiscalPeriodId, {})
    const allIds = all.map((r) => r.entry.id)
    expect(allIds).toEqual(expect.arrayContaining([posted, draft, original, storno, correction]))
    expect(Number(all[0]!.total_count)).toBe(5)

    // Committed list: drafts, stornos and reversed-corrected originals hidden.
    const filtered = await callRpc(companyId, fiscalPeriodId, { excludeDraft: true, collapse: true })
    const ids = filtered.map((r) => r.entry.id)
    expect(ids).toEqual(expect.arrayContaining([posted, correction]))
    expect(ids).not.toContain(draft)
    expect(ids).not.toContain(storno)
    expect(ids).not.toContain(original)
    expect(Number(filtered[0]!.total_count)).toBe(2)
  })

  it('keeps a pure storno (no correction) visible under collapse_corrections (#3149)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Two-row group: a duplicate was reversed and never replaced. The storno is
    // the only row that carries its voucher number, so folding it showed a hole
    // in the series (the customer's "where is A44").
    const duplicate = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'reversed', sourceType: 'manual', voucherNumber: 43, withLines: true, description: 'Duplicate' })
    const pureStorno = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'storno', voucherNumber: 44, reversesId: duplicate, withLines: true, description: 'Storno of duplicate' })
    // Three-row group beside it: still folds to the live correction.
    const original = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'reversed', sourceType: 'manual', voucherNumber: 45, withLines: true, description: 'Original' })
    const storno = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'storno', voucherNumber: 46, reversesId: original, withLines: true, description: 'Storno' })
    const correction = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'correction', voucherNumber: 47, correctionOfId: original, withLines: true, description: 'Correction' })

    const collapsed = await callRpc(companyId, fiscalPeriodId, { collapse: true, sortDate: 'asc' })
    const ids = collapsed.map((r) => r.entry.id)
    expect(ids).toEqual([duplicate, pureStorno, correction])
    expect(ids).not.toContain(original)
    expect(ids).not.toContain(storno)
    // The series reads 43, 44, 47: no hole where the pure storno sits.
    expect(collapsed.map((r) => r.entry.voucher_number)).toEqual([43, 44, 47])
    expect(Number(collapsed[0]!.total_count)).toBe(3)
  })

  it('still returns drafts when status=draft is requested explicitly', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: 10, withLines: true, description: 'Posted' })
    const draft = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'draft', sourceType: 'manual', voucherNumber: 0, description: 'Draft' })

    // Drafts mode (status=draft). exclude_draft must NOT cancel the explicit ask.
    const rows = await callRpc(companyId, fiscalPeriodId, { status: 'draft', excludeDraft: true })
    expect(rows.map((r) => r.entry.id)).toEqual([draft])
  })

  it('filters by voucher series with a total_count over the filtered set (#798)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // 2 entries in series A, 3 in series B.
    for (const n of [1, 2]) {
      await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: n, voucherSeries: 'A', withLines: true, description: `A${n}` })
    }
    for (const n of [1, 2, 3]) {
      await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: n, voucherSeries: 'B', withLines: true, description: `B${n}` })
    }

    // No series filter: all 5.
    const all = await callRpc(companyId, fiscalPeriodId, {})
    expect(Number(all[0]!.total_count)).toBe(5)

    // series=B returns only the 3 B entries, and total_count is the filtered 3.
    const seriesB = await callRpc(companyId, fiscalPeriodId, { series: 'B' })
    expect(seriesB).toHaveLength(3)
    expect(seriesB.every((r) => r.entry.voucher_series === 'B')).toBe(true)
    expect(Number(seriesB[0]!.total_count)).toBe(3)

    // The #798 regression: with a page smaller than the filtered set, the page
    // truncates but total_count still reports the full filtered count (3): the
    // paginator can reach every B entry instead of stopping after one page.
    const firstPage = await callRpc(companyId, fiscalPeriodId, { series: 'B', limit: 2 })
    expect(firstPage).toHaveLength(2)
    expect(Number(firstPage[0]!.total_count)).toBe(3)
  })

  it('tiebreaks same-date vouchers in the date-sort direction (#972)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // The exact scenario from #972: several days carry more than one voucher.
    const spec: Array<[number, string]> = [
      [4, '2026-06-01'],
      [5, '2026-06-07'],
      [6, '2026-06-07'],
      [7, '2026-06-07'],
      [8, '2026-06-08'],
      [9, '2026-06-09'],
      [10, '2026-06-10'],
      [11, '2026-06-10'],
      [12, '2026-06-10'],
      [13, '2026-06-11'],
    ]
    for (const [n, entryDate] of spec) {
      await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: n, entryDate, withLines: true, description: `A${n}` })
    }

    // Date-descending (the default list view): same-date vouchers must also
    // descend, so the whole column reads 13..4 with no zig-zag inside a day.
    const desc = await callRpc(companyId, fiscalPeriodId, { sortDate: 'desc' })
    expect(desc.map((r) => r.entry.voucher_number)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4])

    // Date-ascending: fully chronological registration order.
    const asc = await callRpc(companyId, fiscalPeriodId, { sortDate: 'asc' })
    expect(asc.map((r) => r.entry.voucher_number)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('lists a payment booked in another year under the year of its invoice, marked out_of_period and counted', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const nextYear = await insertFiscalPeriod({ userId, companyId, name: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31' })

    const customerId = randomUUID()
    const invoiceId = randomUUID()
    const otherInvoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
       VALUES ($1, $2, $3, 'Test Kund AB', 'swedish_business')`,
      [customerId, userId, companyId],
    )
    // One invoice dated in 2026, one dated in 2027: only the first makes a
    // 2027 payment a row of the 2026 list.
    for (const [id, invoiceDate] of [[invoiceId, '2026-12-15'], [otherInvoiceId, '2027-01-05']] as const) {
      await getPool().query(
        `INSERT INTO public.invoices
           (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
            currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
            paid_amount, remaining_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'SEK', 1000, 0, 1000, 'standard_25', 25, 'sent', 0, 1000)`,
        [id, userId, companyId, customerId, `F-${id.slice(0, 8)}`, invoiceDate],
      )
    }

    // The supplier side of the same rule: a 2026 supplier invoice paid in 2027.
    const supplierId = randomUUID()
    const supplierInvoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Test Leverantör AB')`,
      [supplierId, userId, companyId],
    )
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number,
          supplier_invoice_number, invoice_date, due_date)
       VALUES ($1, $2, $3, $4, 1, 'INV-1', '2026-12-20', '2027-01-19')`,
      [supplierInvoiceId, userId, companyId, supplierId],
    )

    const own = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: 1, entryDate: '2026-12-15', withLines: true, description: 'Own year' })
    const related = await insertEntry({ userId, companyId, fiscalPeriodId: nextYear, status: 'posted', sourceType: 'invoice_paid', sourceId: invoiceId, voucherNumber: 1, entryDate: '2027-01-10', withLines: true, description: 'Paid next year' })
    const unrelated = await insertEntry({ userId, companyId, fiscalPeriodId: nextYear, status: 'posted', sourceType: 'invoice_paid', sourceId: otherInvoiceId, voucherNumber: 2, entryDate: '2027-01-11', withLines: true, description: 'Next year invoice, next year payment' })
    const otherKind = await insertEntry({ userId, companyId, fiscalPeriodId: nextYear, status: 'posted', sourceType: 'manual', sourceId: invoiceId, voucherNumber: 3, entryDate: '2027-01-12', withLines: true, description: 'Not a payment kind' })
    const relatedSupplier = await insertEntry({ userId, companyId, fiscalPeriodId: nextYear, status: 'posted', sourceType: 'supplier_invoice_paid', sourceId: supplierInvoiceId, voucherNumber: 4, entryDate: '2027-01-13', withLines: true, description: 'Supplier invoice paid next year' })
    // A draft related payment stays off the committed list, like a draft of the year.
    const draftRelated = await insertEntry({ userId, companyId, fiscalPeriodId: nextYear, status: 'draft', sourceType: 'invoice_paid', sourceId: invoiceId, voucherNumber: 0, entryDate: '2027-01-14', description: 'Draft payment next year' })

    const rows = await callRpc(companyId, fiscalPeriodId, { excludeDraft: true, collapse: true })
    // Newest first: the 2027 payments sort above the 2026 row they belong with.
    expect(rows.map((r) => r.entry.id)).toEqual([relatedSupplier, related, own])
    expect(rows.map((r) => r.entry.out_of_period)).toEqual([true, true, false])
    expect(Number(rows[0]!.total_count)).toBe(3)
    expect(rows.map((r) => r.entry.id)).not.toContain(unrelated)
    expect(rows.map((r) => r.entry.id)).not.toContain(otherKind)
    expect(rows.map((r) => r.entry.id)).not.toContain(draftRelated)

    // The date range applies to the related rows too.
    const { rows: ranged } = await getPool().query<{ entry: { id: string }; total_count: string }>(
      `SELECT entry, total_count
         FROM list_fiscal_period_entries_with_related($1, $2, true, NULL, '2027-01-12', '2027-12-31', 'desc', 100, 0, true, true, NULL)`,
      [companyId, fiscalPeriodId],
    )
    expect(ranged.map((r) => r.entry.id)).toEqual([relatedSupplier])
    expect(Number(ranged[0]!.total_count)).toBe(1)

    // The same payments are ordinary rows of their own year, counted once.
    const nextYearRows = await callRpc(companyId, nextYear, { excludeDraft: true, collapse: true })
    expect(nextYearRows.map((r) => r.entry.id)).toEqual([relatedSupplier, otherKind, unrelated, related])
    expect(nextYearRows.every((r) => r.entry.out_of_period === false)).toBe(true)
    expect(Number(nextYearRows[0]!.total_count)).toBe(4)

    // As the signed-in member, under RLS (the function is SECURITY INVOKER and
    // reads journal_entries twice: for the keys and for the rows of the page).
    const asMember = await withUserContext(userId, async (client) => {
      const res = await client.query<{ entry: { id: string }; total_count: string }>(
        `SELECT entry, total_count
           FROM list_fiscal_period_entries_with_related($1, $2, true, NULL, NULL, NULL, 'desc', 100, 0, true, true, NULL)`,
        [companyId, fiscalPeriodId],
      )
      return res.rows
    })
    expect(asMember.map((r) => r.entry.id)).toEqual([relatedSupplier, related, own])
    expect(Number(asMember[0]!.total_count)).toBe(3)

    // Without the related arm the 2026 list is the year's own verifikat.
    const ownOnly = await callRpc(companyId, fiscalPeriodId, { includeRelated: false })
    expect(ownOnly.map((r) => r.entry.id)).toEqual([own])
    expect(Number(ownOnly[0]!.total_count)).toBe(1)
  })

  it('cuts the page out of the sorted set and reports the whole set on every page', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    for (const n of [1, 2, 3, 4, 5]) {
      await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: n, entryDate: `2026-06-0${n}`, withLines: true, description: `A${n}` })
    }
    // A draft is outside the committed list and its total.
    await insertEntry({ userId, companyId, fiscalPeriodId, status: 'draft', sourceType: 'manual', voucherNumber: 0, description: 'Draft' })

    const pageTwo = await callRpc(companyId, fiscalPeriodId, { excludeDraft: true, collapse: true, limit: 2, offset: 2 })
    expect(pageTwo.map((r) => r.entry.voucher_number)).toEqual([3, 2])
    expect(pageTwo.map((r) => Number(r.total_count))).toEqual([5, 5])

    const lastPage = await callRpc(companyId, fiscalPeriodId, { excludeDraft: true, collapse: true, limit: 2, offset: 4, sortDate: 'asc' })
    expect(lastPage.map((r) => r.entry.voucher_number)).toEqual([5])
    expect(Number(lastPage[0]!.total_count)).toBe(5)

    // Past the end there is no row to carry a total: the caller reads zero rows.
    expect(await callRpc(companyId, fiscalPeriodId, { excludeDraft: true, collapse: true, limit: 2, offset: 10 })).toEqual([])
  })

  it('answers the whole verifikat for each row of the page: its columns and its lines', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const withLines = await insertEntry({ userId, companyId, fiscalPeriodId, status: 'posted', sourceType: 'manual', voucherNumber: 7, withLines: true, description: 'With lines' })

    const [row] = await callRpc(companyId, fiscalPeriodId, { excludeDraft: true, collapse: true })
    expect(row!.entry).toMatchObject({
      id: withLines,
      voucher_series: 'A',
      voucher_number: 7,
      description: 'With lines',
      status: 'posted',
      out_of_period: false,
    })
    expect(row!.entry).toHaveProperty('company_id', companyId)
    expect(row!.entry).toHaveProperty('fiscal_period_id', fiscalPeriodId)
    expect(row!.entry).not.toHaveProperty('total')
    // The helper's two lines share sort_order 0, so their order is not pinned here.
    const lines = row!.entry.lines.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)])
    expect(lines.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['1930', 1000, 0],
      ['3001', 0, 1000],
    ])
  })
})
