import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertCashAccount, insertDraftJournalEntry, insertFiscalPeriod, seedCompany } from './fixtures'
import { voucherDisplayAmount } from '@/lib/bookkeeping/voucher-display-amount'
import { VOUCHER_SHAPES, type ShapeLine } from '@/lib/bookkeeping/__tests__/voucher-display-amount.shapes'
import { readVerifikatQuerySearch, verifikatSearchParams } from '@/lib/bookkeeping/verifikat-search'

/**
 * The verifikat list sorted by Belopp (migration 20261125130100). Pins, on
 * real Postgres:
 *   - verifikat_display_amounts gives every voucher shape the amount the list
 *     shows (voucherDisplayAmount) and the amount display_amount gives it;
 *   - list_verifikat_by_amount orders exactly as the direct list query does
 *     with ORDER BY display_amount, pages disjointly and counts every page's
 *     total;
 *   - it applies the list's filters one for one (period, status, drafts,
 *     dates, series, every search reading, hidden pairs, folded corrections);
 *   - another company's verifikat are never returned, and the caller must be
 *     a member of the company asked for.
 */

type ListResult = { ok: boolean; code?: string; total_count?: number; ids?: string[] }

const PARAM_TYPES: Record<string, string> = {
  p_company_id: 'uuid',
  p_period_id: 'uuid',
  p_status: 'text',
  p_exclude_draft: 'boolean',
  p_date_from: 'date',
  p_date_to: 'date',
  p_series: 'text',
  p_search_pattern: 'text',
  p_search_voucher_series: 'text',
  p_search_voucher_number: 'integer',
  p_search_account: 'text',
  p_search_amount: 'numeric',
  p_search_date_from: 'date',
  p_search_date_to: 'date',
  p_hide_reversed: 'boolean',
  p_collapse_corrections: 'boolean',
  p_order: 'text[]',
  p_limit: 'integer',
  p_offset: 'integer',
}

/** list_verifikat_by_amount as the member calls it through PostgREST: named arguments, the rest defaulted. */
async function listAs(userId: string, params: Record<string, unknown>): Promise<ListResult> {
  const keys = Object.keys(params)
  const args = keys.map((k, i) => `${k} => $${i + 1}::${PARAM_TYPES[k]}`).join(', ')
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ r: ListResult }>(
      `SELECT public.list_verifikat_by_amount(${args}) AS r`,
      keys.map((k) => params[k]),
    )
    return rows[0].r
  })
}

/** The search parameters the route sends for a needle (lib/bookkeeping/verifikat-search.ts). */
function searchFor(search: string, periodId: string | null) {
  return verifikatSearchParams(search, readVerifikatQuerySearch(search, { periodId }))
}

const BY_AMOUNT_DESC = ['display_amount.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc']

interface PostParams {
  userId: string
  companyId: string
  periodId: string
  series?: string
  number: number
  date: string
  description: string
  sourceType?: string
  status?: 'posted' | 'reversed'
  reversesId?: string
  correctionOfId?: string
  lines: ShapeLine[]
}

// Header and lines in ONE transaction: check_balance_on_posted_insert is
// deferred to commit, so a posted header committed alone is rejected.
async function post(p: PostParams): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id, correction_of_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'posted', $10, $11)`,
      [
        id,
        p.userId,
        p.companyId,
        p.periodId,
        p.number,
        p.series ?? 'A',
        p.date,
        p.description,
        p.sourceType ?? 'manual',
        p.reversesId ?? null,
        p.correctionOfId ?? null,
      ],
    )
    for (const [index, [account, debit, credit]] of p.lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, account, debit, credit, index],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  if (p.status === 'reversed') {
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [id])
  }
  return id
}

describe('verifikat_display_amounts', () => {
  it('gives every voucher shape the amount the list shows, as display_amount does', async () => {
    // One company per set of extra cash ledgers: a cash account on 1686
    // makes that ledger a money account for every voucher of its company.
    const groups = new Map<string, typeof VOUCHER_SHAPES>()
    for (const shape of VOUCHER_SHAPES) {
      const key = (shape.extraMoneyAccounts ?? []).join(',')
      groups.set(key, [...(groups.get(key) ?? []), shape])
    }

    const results: Array<{ name: string; expected: number; helper: number; set: number; perRow: number }> = []
    for (const [key, shapes] of groups) {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()
      for (const ledger of key ? key.split(',') : []) {
        await insertCashAccount({ companyId, ledgerAccount: ledger, source: 'manual' })
      }
      const entries: Array<{ id: string; shape: (typeof shapes)[number] }> = []
      for (const [index, shape] of shapes.entries()) {
        // A bank_transaction voucher needs its bank row; the rule reads the
        // source type only to tell an opening balance apart.
        const sourceType = shape.source_type === 'bank_transaction' ? 'manual' : shape.source_type
        const id = await post({
          userId, companyId, periodId: fiscalPeriodId, number: index + 1, date: '2026-06-01',
          description: shape.name, sourceType, lines: shape.lines,
        })
        entries.push({ id, shape })
      }

      const ids = entries.map((e) => e.id)
      const { rows: setRows } = await getPool().query<{ journal_entry_id: string; display_amount: string }>(
        `SELECT journal_entry_id, display_amount::text FROM public.verifikat_display_amounts($1, $2::uuid[])`,
        [companyId, ids],
      )
      const setAmount = new Map(setRows.map((r) => [r.journal_entry_id, Number(r.display_amount)]))
      const perRow = await withUserContext(userId, async (client) => {
        const { rows } = await client.query<{ id: string; amount: string }>(
          `SELECT je.id, public.display_amount(je.*)::text AS amount
             FROM public.journal_entries je WHERE je.id = ANY ($1::uuid[])`,
          [ids],
        )
        return new Map(rows.map((r) => [r.id, Number(r.amount)]))
      })
      for (const { id, shape } of entries) {
        const helper = voucherDisplayAmount(
          { source_type: shape.source_type, lines: shape.lines.map(([a, d, c]) => ({ account_number: a, debit_amount: d, credit_amount: c })) },
          new Set(shape.extraMoneyAccounts ?? []),
        ).amount
        results.push({ name: shape.name, expected: shape.expected.amount, helper, set: setAmount.get(id)!, perRow: perRow.get(id)! })
      }
    }

    expect(results).toHaveLength(VOUCHER_SHAPES.length)
    for (const r of results) {
      expect({ name: r.name, set: r.set }).toEqual({ name: r.name, set: r.expected })
      expect({ name: r.name, set: r.set }).toEqual({ name: r.name, set: r.helper })
      expect({ name: r.name, set: r.set }).toEqual({ name: r.name, set: r.perRow })
    }
  })

  it('answers 0 for a verifikat without lines, like the helper and display_amount', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const empty = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const { rows } = await getPool().query<{ display_amount: string }>(
      `SELECT display_amount::text FROM public.verifikat_display_amounts($1, ARRAY[$2::uuid])`,
      [companyId, empty],
    )
    expect(rows.map((r) => Number(r.display_amount))).toEqual([0])
  })

  it("answers only for the given company's verifikat", async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    const foreign = await post({
      userId: other.userId, companyId: other.companyId, periodId: other.fiscalPeriodId, number: 1,
      date: '2026-03-01', description: 'Annans', lines: [['5010', 900, 0], ['1930', 0, 900]],
    })
    const { rows } = await getPool().query(
      `SELECT * FROM public.verifikat_display_amounts($1, ARRAY[$2::uuid])`,
      [own.companyId, foreign],
    )
    expect(rows).toEqual([])
  })

  it('is callable by neither anon nor authenticated: it checks no membership', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
      `SELECT has_function_privilege('anon', 'public.verifikat_display_amounts(uuid, uuid[])', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.verifikat_display_amounts(uuid, uuid[])', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.verifikat_display_amounts(uuid, uuid[])', 'EXECUTE') AS service_role`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })
  })
})

describe('list_verifikat_by_amount', () => {
  let userId: string
  let companyId: string
  let y2026: string
  let y2025: string
  let otherUserId: string
  let otherCompanyId: string
  const v: Record<string, string> = {}

  beforeAll(async () => {
    const s = await seedCompany()
    userId = s.userId
    companyId = s.companyId
    y2026 = s.fiscalPeriodId
    y2025 = await insertFiscalPeriod({ userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
    // A payment provider's balance: 1686 is a money account of this company.
    await insertCashAccount({ companyId, ledgerAccount: '1686', source: 'manual' })
    const entry = (p: Omit<PostParams, 'userId' | 'companyId' | 'periodId'> & { periodId?: string }) =>
      post({ userId, companyId, periodId: p.periodId ?? y2026, ...p })

    // Belopp 900 (the bank line), omslutning 900.
    v.rent = await entry({ number: 1, date: '2026-03-01', description: 'Hyra mars', lines: [['5010', 900, 0], ['1930', 0, 900]] })
    // Belopp 200 (the 1686 line), omslutning 250: the sort follows the 200.
    v.provider = await entry({
      number: 2, date: '2026-03-02', description: 'Programvara',
      lines: [['2645', 50, 0], ['2614', 0, 50], ['6540', 200, 0], ['1686', 0, 200]],
    })
    // Belopp 300, no money line.
    v.fuel = await entry({ series: 'B', number: 1, date: '2026-04-01', description: 'Bensin', lines: [['5611', 300, 0], ['2440', 0, 300]] })
    // Belopp 23 000 (net pay), omslutning 39 426.
    v.salary = await entry({
      number: 3, date: '2026-04-15', description: 'Lön april',
      lines: [['7010', 30000, 0], ['7510', 9426, 0], ['2710', 0, 7000], ['2731', 0, 9426], ['1930', 0, 23000]],
    })
    // Same Belopp as rent: the voucher tiebreak orders them.
    v.rentApril = await entry({ number: 4, date: '2026-04-01', description: 'Hyra april', lines: [['5010', 900, 0], ['1930', 0, 900]] })
    // The earlier year.
    v.old = await entry({ periodId: y2025, number: 1, date: '2025-06-01', description: 'Gammal HYRA', lines: [['5010', 500, 0], ['1930', 0, 500]] })
    // A corrected group: the original (reversed), its storno and the correction.
    v.wrong = await entry({ number: 5, date: '2026-02-01', description: 'Fel konto', status: 'reversed', lines: [['5410', 700, 0], ['1930', 0, 700]] })
    v.wrongStorno = await entry({
      number: 6, date: '2026-02-02', description: 'Makulering', sourceType: 'storno', reversesId: v.wrong,
      lines: [['1930', 700, 0], ['5410', 0, 700]],
    })
    v.corrected = await entry({
      number: 7, date: '2026-02-02', description: 'Rättelse', sourceType: 'correction', correctionOfId: v.wrong,
      lines: [['5460', 700, 0], ['1930', 0, 700]],
    })
    // A pure storno pair: nothing corrected it.
    v.voided = await entry({ number: 8, date: '2026-02-10', description: 'Dubblett', status: 'reversed', lines: [['6110', 120, 0], ['1930', 0, 120]] })
    v.voidedStorno = await entry({
      number: 9, date: '2026-02-11', description: 'Makulering dubblett', sourceType: 'storno', reversesId: v.voided,
      lines: [['1930', 120, 0], ['6110', 0, 120]],
    })
    v.draft = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId: y2026, entryDate: '2026-05-01', description: 'Utkast' })
    v.cancelled = await insertDraftJournalEntry({
      userId, companyId, fiscalPeriodId: y2026, entryDate: '2026-05-02', description: 'Avbruten', status: 'cancelled',
    })

    // Another company whose verifikat matches every filter and search below.
    const other = await seedCompany()
    otherUserId = other.userId
    otherCompanyId = other.companyId
    v.foreign = await post({
      userId: other.userId, companyId: other.companyId, periodId: other.fiscalPeriodId, number: 1, date: '2026-03-01',
      description: 'Hyra mars', lines: [['5010', 900, 0], ['1930', 0, 900]],
    })
  })

  const ids = (r: ListResult) => {
    expect(r.ok).toBe(true)
    return r.ids ?? []
  }

  it('orders exactly as the direct list query does with ORDER BY display_amount, page by page', async () => {
    // What the route sent before: the computed column, the voucher tiebreak
    // in the last key's direction, then the id (route.ts on main).
    const today = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT je.id FROM public.journal_entries je
          WHERE je.company_id = $1 AND je.status <> 'cancelled' AND je.status <> 'draft'
          ORDER BY public.display_amount(je) DESC, je.voucher_series DESC, je.voucher_number DESC, je.id DESC`,
        [companyId],
      )
      return rows.map((r) => r.id)
    })

    const paged: string[] = []
    for (let offset = 0; offset < today.length + 2; offset += 2) {
      const page = await listAs(userId, {
        p_company_id: companyId, p_exclude_draft: true, p_order: BY_AMOUNT_DESC, p_limit: 2, p_offset: offset,
      })
      expect(page.total_count).toBe(today.length)
      paged.push(...ids(page))
    }
    expect(paged).toEqual(today)
    // The numbers on screen, not the omslutning: 23 000 first, 200 below 300.
    expect(paged.slice(0, 1)).toEqual([v.salary])
    expect(paged.indexOf(v.fuel)).toBeLessThan(paged.indexOf(v.provider))
    // Equal amounts: the later voucher number first, as the tiebreak says.
    expect(paged.indexOf(v.rentApril)).toBeLessThan(paged.indexOf(v.rent))
  })

  it('orders ascending and by a stacked sort as the direct query would', async () => {
    const asc = ids(await listAs(userId, {
      p_company_id: companyId, p_period_id: y2026, p_exclude_draft: true,
      p_order: ['display_amount.asc', 'voucher_series.asc', 'voucher_number.asc', 'id.asc'],
    }))
    expect(asc.slice(0, 2)).toEqual([v.voided, v.voidedStorno])
    expect(asc[asc.length - 1]).toBe(v.salary)

    // date_desc, total_asc: the date first, the amount inside a day.
    const stacked = ids(await listAs(userId, {
      p_company_id: companyId, p_period_id: y2026, p_exclude_draft: true,
      p_order: ['entry_date.desc', 'display_amount.asc', 'voucher_series.asc', 'voucher_number.asc', 'id.asc'],
    }))
    const sameDay = stacked.filter((id) => id === v.wrongStorno || id === v.corrected)
    expect(sameDay).toEqual([v.wrongStorno, v.corrected])
    expect(stacked[0]).toBe(v.salary)
  })

  it('narrows by fiscal year, explicit status, drafts, dates and series', async () => {
    const base = { p_company_id: companyId, p_order: BY_AMOUNT_DESC }
    const year2025 = ids(await listAs(userId, { ...base, p_period_id: y2025 }))
    expect(year2025).toEqual([v.old])

    // Drafts are left out only when asked; cancelled only when named.
    const withDrafts = ids(await listAs(userId, { ...base, p_period_id: y2026 }))
    expect(withDrafts).toContain(v.draft)
    expect(withDrafts).not.toContain(v.cancelled)
    const committed = ids(await listAs(userId, { ...base, p_period_id: y2026, p_exclude_draft: true }))
    expect(committed).not.toContain(v.draft)
    expect(ids(await listAs(userId, { ...base, p_status: 'cancelled', p_exclude_draft: true }))).toEqual([v.cancelled])
    expect(ids(await listAs(userId, { ...base, p_status: 'reversed' })).sort()).toEqual([v.wrong, v.voided].sort())

    const march = ids(await listAs(userId, { ...base, p_date_from: '2026-03-01', p_date_to: '2026-03-31' }))
    expect(march).toEqual([v.rent, v.provider])
    expect(ids(await listAs(userId, { ...base, p_series: 'B' }))).toEqual([v.fuel])
  })

  it('reads every search reading as an arm next to the text, as the direct query does', async () => {
    const base = { p_company_id: companyId, p_exclude_draft: true, p_order: BY_AMOUNT_DESC }
    // Text, case-insensitive, and both years without a period.
    const hyra = ids(await listAs(userId, { ...base, ...searchFor('hyra', null) }))
    expect(hyra).toEqual([v.rentApril, v.rent, v.old])
    // PostgREST reads * as % in the direct query's pattern.
    expect(ids(await listAs(userId, { ...base, ...searchFor('h*ra', null) }))).toEqual([v.rentApril, v.rent, v.old])
    // A LIKE wildcard typed is a literal.
    expect(ids(await listAs(userId, { ...base, ...searchFor('hyr_', null) }))).toEqual([])
    // A voucher label: series + number.
    expect(ids(await listAs(userId, { ...base, p_period_id: y2026, ...searchFor('B1', y2026) }))).toEqual([v.fuel])
    // An account: a line on 2440.
    expect(ids(await listAs(userId, { ...base, ...searchFor('2440', null) }))).toEqual([v.fuel])
    // An amount, read inside a fiscal period only: a line of 200.
    expect(ids(await listAs(userId, { ...base, p_period_id: y2026, ...searchFor('200', y2026) }))).toEqual([v.provider])
    expect(ids(await listAs(userId, { ...base, ...searchFor('200', null) }))).toEqual([])
    // A bokföringsdatum, and a month.
    expect(ids(await listAs(userId, { ...base, ...searchFor('2026-04-15', null) }))).toEqual([v.salary])
    expect(ids(await listAs(userId, { ...base, ...searchFor('2026-04', null) }))).toEqual([v.salary, v.rentApril, v.fuel])
  })

  it('hides every makulerad pair, or folds only the corrected group, as the direct query does', async () => {
    const base = { p_company_id: companyId, p_period_id: y2026, p_exclude_draft: true, p_order: BY_AMOUNT_DESC }
    const all = ids(await listAs(userId, base))
    expect(all).toEqual(expect.arrayContaining([v.wrong, v.wrongStorno, v.corrected, v.voided, v.voidedStorno]))

    const hidden = ids(await listAs(userId, { ...base, p_hide_reversed: true }))
    expect(hidden).toContain(v.corrected)
    for (const gone of [v.wrong, v.wrongStorno, v.voided, v.voidedStorno]) expect(hidden).not.toContain(gone)

    // The fold: the corrected original and its storno go, the storno nothing
    // corrected stays with its original (#3149).
    const folded = ids(await listAs(userId, { ...base, p_collapse_corrections: true }))
    expect(folded).toContain(v.corrected)
    expect(folded).toContain(v.voided)
    expect(folded).toContain(v.voidedStorno)
    expect(folded).not.toContain(v.wrong)
    expect(folded).not.toContain(v.wrongStorno)
    expect(folded.length).toBe(all.length - 2)
  })

  it("never returns another company's verifikat, and refuses a company the caller is no member of", async () => {
    const everything = {
      p_order: BY_AMOUNT_DESC,
      p_date_from: '2026-03-01',
      p_date_to: '2026-03-01',
      ...searchFor('Hyra mars', null),
    }
    const own = ids(await listAs(userId, { p_company_id: companyId, ...everything }))
    expect(own).toEqual([v.rent])
    expect(own).not.toContain(v.foreign)

    const refused = await listAs(userId, { p_company_id: otherCompanyId, ...everything })
    expect(refused).toEqual({ ok: false, code: 'LIST_VERIFIKAT_BY_AMOUNT_FORBIDDEN' })
    // Its own member sees it.
    expect(ids(await listAs(otherUserId, { p_company_id: otherCompanyId, ...everything }))).toEqual([v.foreign])
  })

  it('refuses an order token outside the allowlist and clamps the page size', async () => {
    const refused = await listAs(userId, { p_company_id: companyId, p_order: ['display_amount desc; select 1'] })
    expect(refused).toEqual({ ok: false, code: 'LIST_VERIFIKAT_BY_AMOUNT_INVALID_ORDER' })
    const one = await listAs(userId, { p_company_id: companyId, p_order: BY_AMOUNT_DESC, p_limit: 0 })
    expect(ids(one)).toHaveLength(1)
  })

  it('is not executable by anon', async () => {
    const sig = 'public.list_verifikat_by_amount(uuid, uuid, text, boolean, date, date, text, text, text, integer, text, numeric, date, date, boolean, boolean, text[], integer, integer)'
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean }>(
      `SELECT has_function_privilege('anon', '${sig}', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true })
  })
})
