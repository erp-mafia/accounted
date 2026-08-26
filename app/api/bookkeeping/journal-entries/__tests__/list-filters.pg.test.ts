import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Covers the p_exclude_draft / p_collapse_corrections / p_series params on
// list_fiscal_period_entries_with_related (migrations 20260621130500 +
// 20260629160000).
//   - exclude_draft: drafts kept off the committed list (own "Utkast" surface).
//   - collapse_corrections: a correction group renders as ONE row: the live
//     correction; the storno and the reversed original it replaced are hidden.
//   - series: voucher-series filter; pushed into the RPC so total_count reflects
//     the filtered set (the route used to post-filter and recompute count from
//     one page, breaking pagination, #798).
// total_count must stay in lockstep with the filtered set so pagination holds.
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
    withLines?: boolean
  }): Promise<string> {
    const id = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status, reverses_id, correction_of_id)
         VALUES ($1,$2,$3,$4,$5,$11,$12,$6,$7,$8,$9,$10)`,
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
      sortDate?: 'asc' | 'desc'
    } = {},
  ) {
    const { rows } = await getPool().query<{
      entry: { id: string; voucher_series: string; voucher_number: number }
      total_count: string
    }>(
      `SELECT entry, total_count
         FROM list_fiscal_period_entries_with_related(
           $1, $2, true, $3, NULL, NULL, $8, $6, 0, $4, $5, $7)`,
      [
        companyId,
        periodId,
        opts.status ?? null,
        opts.excludeDraft ?? false,
        opts.collapse ?? false,
        opts.limit ?? 100,
        opts.series ?? null,
        opts.sortDate ?? 'desc',
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
})
