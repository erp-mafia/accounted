/**
 * pg-real tests for pågående arbeten (K3 kapitel 23):
 * 20261027180109_contract_revenue.sql and 20261108174501_contract_revenue_bookings.sql.
 *
 * Pinned here:
 *   - the adjustment account stays outside the momsdeklaration: refused when
 *     the fixed BAS map or the ruta 05 exclusions name it, pinned at no
 *     momskod, no momsruta and momssats 0 while the settings name it or the
 *     register's verifikat carry a line on it, released otherwise;
 *   - an account with posted lines outside the register's verifikat is
 *     refused (in use for something else);
 *   - commit_contract_revenue posts a year_end draft on balansdagen and
 *     records what it was computed from; it refuses a year not reported
 *     under K3, a draft computed from a register that changed since (a
 *     double click), another method or account than the settings, a line on
 *     an account outside the booking and a draft on another day;
 *   - the register's balance counts only its own verifikat and their
 *     stornos, never a manual posting on the same account;
 *   - a booking is immutable;
 *   - RLS: a company sees only its own rows; a viewer reads but writes
 *     nothing (the settings' UPDATE included); an invoicer sees nothing and
 *     writes nothing; a writing member writes the settings and the uppdrag,
 *     deletes the settings and books through commit_contract_revenue.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
  setActiveCompany,
} from './fixtures'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'
import { RUTA_05_EXCLUDED_ACCOUNTS } from '@/lib/reports/vat-revenue-accounts'
import { DEFAULT_CONTRACT_REVENUE_ACCOUNTS } from '@/lib/bokslut/pagaende-arbeten/calculator'

type Company = { userId: string; companyId: string; fiscalPeriodId: string }
let companyA: Company
let companyB: Company

async function insertAccount(company: Company, number: string, rate: number | null = null) {
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type, is_system_account, default_vat_rate)
     VALUES ($1, $2, $3, $4, 3, $5, 'revenue', 'credit', 'full_bas', false, $6)
     ON CONFLICT DO NOTHING`,
    [company.userId, company.companyId, number, `Konto ${number}`, number.slice(0, 2), rate],
  )
}

async function saveSettings(company: Company, account: string, method = 'successiv') {
  await getPool().query(
    `INSERT INTO public.contract_revenue_settings (company_id, user_id, method, revenue_account)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET revenue_account = EXCLUDED.revenue_account, method = EXCLUDED.method`,
    [company.companyId, company.userId, method, account],
  )
}

/** The year and the company reported under K3. */
async function k3Company(): Promise<Company> {
  const company = await seedCompany()
  await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [company.companyId])
  await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = 'k3' WHERE fiscal_period_id = $1`, [
    company.fiscalPeriodId,
  ])
  return company
}

/** A K3 company with 3095 pinned and chosen as the adjustment account. */
async function configuredCompany(): Promise<Company> {
  const company = await k3Company()
  await insertAccount(company, '3095', 0)
  await saveSettings(company, '3095')
  return company
}

async function insertDraft(
  company: Company,
  lines: Array<[string, number, number]>,
  options: { entryDate?: string } = {},
): Promise<string> {
  const db = getPool()
  const entryId = randomUUID()
  await db.query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Successiv vinstavräkning', 'year_end', 'draft')`,
    [entryId, company.userId, company.companyId, company.fiscalPeriodId, options.entryDate ?? '2026-12-31'],
  )
  for (const [account, debit, credit] of lines) {
    await db.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [entryId, account, debit, credit],
    )
  }
  return entryId
}

const ACCOUNTS = { ...DEFAULT_CONTRACT_REVENUE_ACCOUNTS, revenueAdjustment: '3095' }

/** What the TypeScript side sends: the register's targets on the five position accounts, 1620 given. */
function booking(accruedRevenue: number, overrides: Record<string, unknown> = {}) {
  return {
    method: 'successiv',
    accounts: ACCOUNTS,
    contracts: [{ id: 'c1', name: 'Tak Storgatan 1', uppdragsinkomst: 1_000_000 }],
    positions: [{ id: 'c1', netto: accruedRevenue }],
    targets: { '1620': accruedRevenue, '2450': 0, '2290': 0, '1471': 0, '2431': 0 },
    ...overrides,
  }
}

const COMMIT_SQL = `SELECT * FROM public.commit_contract_revenue($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`

function commit(company: Company, entryId: string, payload: unknown, client?: PoolClient) {
  return (client ?? getPool()).query<{ voucher_number: number }>(COMMIT_SQL, [
    company.companyId,
    entryId,
    company.fiscalPeriodId,
    JSON.stringify(payload),
  ])
}

/** Draft and commit an adjustment that moves 1620 by `amount` against 3095, to `target`. */
async function bookAdjustment(company: Company, amount: number, target: number): Promise<string> {
  const entryId = await insertDraft(company, [
    ['1620', amount, 0],
    ['3095', 0, amount],
  ])
  await commit(company, entryId, booking(target))
  return entryId
}

async function registerBalances(company: Company): Promise<Record<string, number>> {
  const { rows } = await getPool().query<{ account_number: string; balance: string }>(
    `SELECT * FROM public.contract_revenue_register_balances($1, '2026-12-31')`,
    [company.companyId],
  )
  return Object.fromEntries(rows.map((r) => [r.account_number, Number(r.balance)]))
}

/** Voucher numbers for the hand-made stornos and rättelser, one each. */
let handNumber = 900

async function storno(company: Company, entryId: string, entryDate = '2026-12-31'): Promise<string> {
  const stornoId = randomUUID()
  const number = handNumber++
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, $7, 'A', $6, 'Storno', 'storno', 'draft', $5)`,
      [stornoId, company.userId, company.companyId, company.fiscalPeriodId, entryId, entryDate, number],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [stornoId, entryId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [stornoId])
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`, [
    entryId,
    stornoId,
  ])
  return stornoId
}

/** A posted rättelse verifikat replacing `entryId` (correction_of_id), moving 1620 by `amount`. */
async function correctionOf(company: Company, entryId: string, amount: number, entryDate: string): Promise<string> {
  const id = randomUUID()
  const number = handNumber++
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, correction_of_id)
       VALUES ($1, $2, $3, $4, $7, 'A', $6, 'Rättelse', 'correction', 'draft', $5)`,
      [id, company.userId, company.companyId, company.fiscalPeriodId, entryId, entryDate, number],
    )
    for (const [account, debit, credit] of [['1620', amount, 0], ['3095', 0, amount]] as const) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [id, account, debit, credit],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  return id
}

beforeAll(async () => {
  companyA = await seedCompany()
  companyB = await seedCompany()
})

describe('contract revenue: the adjustment account stays outside the momsdeklaration', () => {
  it('refuses every class 3 account the fixed ruta map or the ruta 05 exclusions name', async () => {
    const named = [
      ...Object.keys(VAT_ACCOUNT_TABLE).filter((a) => a.startsWith('3')),
      ...RUTA_05_EXCLUDED_ACCOUNTS,
    ].filter((a) => /^3[0-7]/.test(a))
    expect(named.length).toBeGreaterThan(10)
    for (const account of named) {
      await insertAccount(companyA, account, 0)
      await expect(saveSettings(companyA, account), account).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('refuses an account outside nettoomsättning and one that is not pinned yet', async () => {
    await insertAccount(companyA, '3910', 0)
    await expect(saveSettings(companyA, '3910')).rejects.toMatchObject({ code: '23514' })
    await insertAccount(companyA, '3091', null)
    await expect(saveSettings(companyA, '3091')).rejects.toMatchObject({ code: '23514' })
    await expect(saveSettings(companyA, '3092')).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps the pinned account at no momskod, no momsruta and momssats 0', async () => {
    await insertAccount(companyA, '3090', 0)
    await saveSettings(companyA, '3090')
    for (const change of [
      `default_vat_rate = 0.25`,
      `default_vat_rate = NULL`,
      `default_vat_treatment = 'standard_25'`,
    ]) {
      await expect(getPool().query(
        `UPDATE public.chart_of_accounts SET ${change} WHERE company_id = $1 AND account_number = '3090'`,
        [companyA.companyId],
      ), change).rejects.toMatchObject({ code: '23514' })
    }
    // Another company's 3090 is its own.
    await insertAccount(companyB, '3090', 0)
    await getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '3090'`,
      [companyB.companyId],
    )
  })

  it('refuses an account with posted lines outside the register, which the app asks first', async () => {
    const company = await k3Company()
    await insertAccount(company, '3093', 0)
    await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      lines: [
        { accountNumber: '1930', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '3093', debitAmount: 0, creditAmount: 500 },
      ],
    })
    const { rows } = await getPool().query<{ in_use: boolean }>(
      `SELECT public.contract_revenue_account_in_use($1, '3093') AS in_use`,
      [company.companyId],
    )
    expect(rows[0].in_use).toBe(true)
    await expect(saveSettings(company, '3093')).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_ACCOUNT_IN_USE',
    })
  })

  it('moves the settings freely; an account the register booked on stays pinned, one it never touched is released', async () => {
    const company = await configuredCompany()
    await insertAccount(company, '3096', 0)
    await insertAccount(company, '3097', 0)
    // 3095 carries the register's verifikat; 3096 is chosen and left unused.
    await bookAdjustment(company, 200_000, 200_000)
    await saveSettings(company, '3096')
    await saveSettings(company, '3097')
    await expect(getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '3095'`,
      [company.companyId],
    )).rejects.toMatchObject({ code: '23514' })
    await getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '3096'`,
      [company.companyId],
    )
    // The register's own lines are no other use: 3095 can be chosen again.
    await saveSettings(company, '3095')
  })

  it('leaves the position and cost accounts free to edit after a booking', async () => {
    const company = await configuredCompany()
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class,
          account_group, account_type, normal_balance, plan_type, is_system_account, default_vat_rate)
       VALUES ($1, $2, '2290', 'Övriga avsättningar', 2, '22', 'liability', 'credit', 'full_bas', false, NULL)`,
      [company.userId, company.companyId],
    )
    const entryId = await insertDraft(company, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
      ['6330', 500, 0],
      ['2290', 0, 500],
    ])
    await commit(company, entryId, booking(1_000, {
      targets: { '1620': 1_000, '2450': 0, '2290': -500, '1471': 0, '2431': 0 },
    }))
    // What the account editor sends for a name change: the VAT fields as they are.
    await getPool().query(
      `UPDATE public.chart_of_accounts
          SET account_name = 'Övriga avsättningar, garantier', default_vat_rate = NULL, default_vat_treatment = NULL
        WHERE company_id = $1 AND account_number = '2290'`,
      [company.companyId],
    )
    await getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '2290'`,
      [company.companyId],
    )
    // The adjustment account itself keeps its pin.
    await expect(getPool().query(
      `UPDATE public.chart_of_accounts SET default_vat_rate = 0.25 WHERE company_id = $1 AND account_number = '3095'`,
      [company.companyId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('lets the settings be saved again on their own account after a manual line on it, and not chosen anew', async () => {
    const company = await configuredCompany()
    await insertAccount(company, '3096', 0)
    await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      lines: [
        { accountNumber: '1930', debitAmount: 100, creditAmount: 0 },
        { accountNumber: '3095', debitAmount: 0, creditAmount: 100 },
      ],
    })
    // An upsert fires the INSERT trigger on its proposed row: a method change is no new choice.
    await saveSettings(company, '3095', 'fardigstallande')
    await saveSettings(company, '3096')
    await expect(saveSettings(company, '3095')).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_ACCOUNT_IN_USE',
    })
  })
})

describe('commit_contract_revenue', () => {
  it('posts the adjustment on balansdagen and records what it was computed from', async () => {
    const company = await configuredCompany()
    const entryId = await insertDraft(company, [
      ['1620', 200_000, 0],
      ['3095', 0, 200_000],
    ])
    const { rows } = await commit(company, entryId, booking(200_000))
    expect(rows[0].voucher_number).toBeGreaterThan(0)

    const { rows: entry } = await getPool().query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [entryId])
    expect(entry[0].status).toBe('posted')
    const { rows: bookings } = await getPool().query(
      `SELECT balansdag::text AS balansdag, method, revenue_account, contracts, targets, held_before
         FROM public.contract_revenue_bookings WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(bookings).toEqual([
      {
        balansdag: '2026-12-31',
        method: 'successiv',
        revenue_account: '3095',
        contracts: [{ id: 'c1', name: 'Tak Storgatan 1', uppdragsinkomst: 1_000_000 }],
        targets: { '1620': 200_000, '2450': 0, '2290': 0, '1471': 0, '2431': 0 },
        held_before: { '1620': 0, '2450': 0, '2290': 0, '1471': 0, '2431': 0 },
      },
    ])
    expect(await registerBalances(company)).toEqual({ '1620': 200_000, '3095': -200_000 })
  })

  it('refuses a second draft computed from the same register: a double click posts once', async () => {
    const company = await configuredCompany()
    await bookAdjustment(company, 200_000, 200_000)
    const again = await insertDraft(company, [
      ['1620', 200_000, 0],
      ['3095', 0, 200_000],
    ])
    await expect(commit(company, again, booking(200_000))).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_STALE',
    })
    // The change from what the register holds is what posts.
    const change = await insertDraft(company, [
      ['1620', 50_000, 0],
      ['3095', 0, 50_000],
    ])
    await expect(commit(company, change, booking(250_000))).resolves.toBeTruthy()
    const { rows } = await getPool().query<{ held_before: Record<string, number> }>(
      `SELECT held_before FROM public.contract_revenue_bookings WHERE journal_entry_id = $1`,
      [change],
    )
    expect(Number(rows[0].held_before['1620'])).toBe(200_000)
  })

  it('counts only the register\'s own verifikat and their stornos, never a manual posting on the account', async () => {
    const company = await configuredCompany()
    const first = await bookAdjustment(company, 200_000, 200_000)
    // A manual pågående-arbeten posting and another provision on 2290.
    await insertPostedJournalEntry({
      userId: company.userId,
      companyId: company.companyId,
      fiscalPeriodId: company.fiscalPeriodId,
      entryDate: '2026-12-31',
      lines: [
        { accountNumber: '1620', debitAmount: 70_000, creditAmount: 0 },
        { accountNumber: '2290', debitAmount: 0, creditAmount: 70_000 },
      ],
    })
    expect(await registerBalances(company)).toEqual({ '1620': 200_000, '3095': -200_000 })
    const stornoId = await storno(company, first)
    expect(await registerBalances(company)).toEqual({ '1620': 0, '3095': 0 })
    const { rows } = await getPool().query<{ id: string }>(`SELECT r.id FROM public.contract_revenue_entry_ids($1) AS r(id)`, [
      company.companyId,
    ])
    expect(rows.map((r) => r.id).sort()).toEqual([first, stornoId].sort())
  })

  it('refuses an earlier year while a later year\'s booking stands, and books it once that is reversed', async () => {
    const company = await configuredCompany()
    const y2027 = await insertFiscalPeriod({
      userId: company.userId,
      companyId: company.companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = 'k3' WHERE fiscal_period_id = $1`, [y2027])
    const later = { ...company, fiscalPeriodId: y2027 }
    const laterEntry = await insertDraft(later, [
      ['1620', 300_000, 0],
      ['3095', 0, 300_000],
    ], { entryDate: '2027-12-31' })
    await commit(later, laterEntry, booking(300_000))

    const earlier = await insertDraft(company, [
      ['1620', 100_000, 0],
      ['3095', 0, 100_000],
    ])
    await expect(commit(company, earlier, booking(100_000))).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_LATER_YEAR_BOOKED',
    })
    await storno(later, laterEntry, '2027-12-31')
    // A rättelse verifikat that replaced the later booking stands in its place.
    const correction = await correctionOf(later, laterEntry, 280_000, '2027-12-31')
    await expect(commit(company, earlier, booking(100_000))).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_LATER_YEAR_BOOKED',
    })
    await storno(later, correction, '2027-12-31')
    await expect(commit(company, earlier, booking(100_000))).resolves.toBeTruthy()
  })

  it('refuses a year not reported under K3', async () => {
    const company = await seedCompany()
    await insertAccount(company, '3095', 0)
    await saveSettings(company, '3095')
    const entryId = await insertDraft(company, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
    ])
    await expect(commit(company, entryId, booking(1_000))).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_NOT_K3',
    })
  })

  it('refuses another method or account than the saved settings', async () => {
    const company = await configuredCompany()
    const entryId = await insertDraft(company, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
    ])
    await expect(commit(company, entryId, booking(1_000, { method: 'fardigstallande' }))).rejects.toMatchObject({
      code: 'PT409',
      message: 'CONTRACT_REVENUE_STALE',
    })
    await expect(
      commit(company, entryId, booking(1_000, { accounts: { ...ACCOUNTS, revenueAdjustment: '3099' } })),
    ).rejects.toMatchObject({ code: 'PT409', message: 'CONTRACT_REVENUE_STALE' })
  })

  it('refuses a line outside the booking\'s accounts, a draft on another day and a malformed booking', async () => {
    const company = await configuredCompany()
    const other = await insertDraft(company, [
      ['1620', 1_000, 0],
      ['1930', 0, 1_000],
    ])
    await expect(commit(company, other, booking(1_000))).rejects.toMatchObject({ code: '23514' })
    const midYear = await insertDraft(company, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
    ], { entryDate: '2026-06-30' })
    await expect(commit(company, midYear, booking(1_000))).rejects.toMatchObject({ code: '22023' })
    const draft = await insertDraft(company, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
    ])
    await expect(commit(company, draft, booking(1_000, { targets: {} }))).rejects.toMatchObject({ code: '22023' })
    await expect(commit(company, draft, booking(1_000, { targets: { '1930': 1_000 } }))).rejects.toMatchObject({ code: '22023' })
    await expect(commit(company, draft, booking(1_000, { contracts: 'x' }))).rejects.toMatchObject({ code: '22023' })
  })

  it('keeps a booking immutable', async () => {
    const company = await configuredCompany()
    const entryId = await bookAdjustment(company, 1_000, 1_000)
    await expect(
      getPool().query(`UPDATE public.contract_revenue_bookings SET method = 'fardigstallande' WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`DELETE FROM public.contract_revenue_bookings WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('contract revenue: RLS', () => {
  it('shows a company only its own uppdrag, settings and bookings', async () => {
    await saveSettings(companyA, '3090')
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'Ombyggnad', '2026-12-31', 1000000, 800000) RETURNING id`,
      [companyA.companyId, companyA.userId],
    )
    const id = rows[0].id
    const seen = async (company: Company) =>
      withUserContext(company.userId, async (client) => ({
        contracts: (await client.query('SELECT id FROM public.contract_revenue_contracts WHERE id = $1', [id])).rowCount,
        settings: (await client.query('SELECT 1 FROM public.contract_revenue_settings WHERE company_id = $1', [companyA.companyId])).rowCount,
      }))
    expect(await seen(companyB)).toEqual({ contracts: 0, settings: 0 })
    expect(await seen(companyA)).toEqual({ contracts: 1, settings: 1 })

    const booked = await configuredCompany()
    await bookAdjustment(booked, 1_000, 1_000)
    const bookingsSeen = (userId: string) =>
      withUserContext(userId, async (client) =>
        (await client.query('SELECT 1 FROM public.contract_revenue_bookings WHERE company_id = $1', [booked.companyId])).rowCount)
    expect(await bookingsSeen(companyB.userId)).toBe(0)
    expect(await bookingsSeen(booked.userId)).toBe(1)
  })

  it('lets a viewer read but not write the settings, an uppdrag or a booking', async () => {
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: companyA.companyId, userId: viewerId, role: 'viewer' })
    await saveSettings(companyA, '3090')
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'Tak', '2026-12-31', 500000, 400000) RETURNING id`,
      [companyA.companyId, companyA.userId],
    )
    const seen = await withUserContext(viewerId, async (client) =>
      (await client.query('SELECT id FROM public.contract_revenue_contracts WHERE id = $1', [rows[0].id])).rowCount)
    expect(seen).toBe(1)
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'X', '2026-12-31', 100, 80)`,
      [companyA.companyId, viewerId],
    ))).rejects.toMatchObject({ code: '42501' })
    await expect(withUserContext(viewerId, (client) =>
      client.query('UPDATE public.contract_revenue_contracts SET contract_value = 1 WHERE id = $1', [rows[0].id]),
    )).rejects.toMatchObject({ code: '42501' })
    const deleted = await withUserContext(viewerId, async (client) =>
      (await client.query('DELETE FROM public.contract_revenue_contracts WHERE id = $1', [rows[0].id])).rowCount)
    expect(deleted).toBe(0)
    await expect(withUserContext(viewerId, (client) => client.query(
      `INSERT INTO public.contract_revenue_settings (company_id, user_id, method, revenue_account)
       VALUES ($1, $2, 'successiv', '3990')`,
      [companyA.companyId, viewerId],
    ))).rejects.toMatchObject({ code: '42501' })
    // The settings' UPDATE (accounted#111 test gap): a viewer changes nothing.
    await expect(withUserContext(viewerId, (client) =>
      client.query(`UPDATE public.contract_revenue_settings SET method = 'fardigstallande' WHERE company_id = $1`, [companyA.companyId]),
    )).rejects.toMatchObject({ code: '42501' })
    const settingsDeleted = await withUserContext(viewerId, async (client) =>
      (await client.query('DELETE FROM public.contract_revenue_settings WHERE company_id = $1', [companyA.companyId])).rowCount)
    expect(settingsDeleted).toBe(0)
    // A booking is written only by commit_contract_revenue, and never for a viewer.
    const booked = await configuredCompany()
    const viewerOfBooked = await insertAuthUser()
    await insertCompanyMember({ companyId: booked.companyId, userId: viewerOfBooked, role: 'viewer' })
    const draft = await insertDraft(booked, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
    ])
    await expect(withUserContext(viewerOfBooked, (client) => commit(booked, draft, booking(1_000), client))).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('shows an invoicer nothing and lets it write nothing (accounted#111 test gap)', async () => {
    const company = await configuredCompany()
    const invoicer = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: invoicer, role: 'invoicer' })
    await setActiveCompany(invoicer, company.companyId)
    await getPool().query(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'Fasad', '2026-12-31', 300000, 200000)`,
      [company.companyId, company.userId],
    )
    await bookAdjustment(company, 1_000, 1_000)
    const counts = await withUserContext(invoicer, async (client) => ({
      settings: (await client.query('SELECT 1 FROM public.contract_revenue_settings WHERE company_id = $1', [company.companyId])).rowCount,
      contracts: (await client.query('SELECT 1 FROM public.contract_revenue_contracts WHERE company_id = $1', [company.companyId])).rowCount,
      bookings: (await client.query('SELECT 1 FROM public.contract_revenue_bookings WHERE company_id = $1', [company.companyId])).rowCount,
    }))
    expect(counts).toEqual({ settings: 0, contracts: 0, bookings: 0 })
    await expect(withUserContext(invoicer, (client) => client.query(
      `INSERT INTO public.contract_revenue_contracts
         (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
       VALUES ($1, $2, 'X', '2026-12-31', 100, 80)`,
      [company.companyId, invoicer],
    ))).rejects.toMatchObject({ code: '42501' })
    const updated = await withUserContext(invoicer, async (client) =>
      (await client.query(`UPDATE public.contract_revenue_settings SET method = 'fardigstallande' WHERE company_id = $1`, [company.companyId])).rowCount)
    expect(updated).toBe(0)
    const deleted = await withUserContext(invoicer, async (client) =>
      (await client.query('DELETE FROM public.contract_revenue_settings WHERE company_id = $1', [company.companyId])).rowCount)
    expect(deleted).toBe(0)
    const draft = await insertDraft(company, [
      ['1620', 500, 0],
      ['3095', 0, 500],
    ])
    await expect(withUserContext(invoicer, (client) => commit(company, draft, booking(1_500), client))).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('lets a writing member save the settings, keep the uppdrag, book the year and stop using it (accounted#111 test gap)', async () => {
    const company = await k3Company()
    await insertAccount(company, '3095', 0)
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: company.companyId, userId: member, role: 'member' })
    await setActiveCompany(member, company.companyId)
    // The member's draft, as the engine writes it before the commit.
    const draft = await insertDraft({ ...company, userId: member }, [
      ['1620', 1_000, 0],
      ['3095', 0, 1_000],
    ])
    const result = await withUserContext(member, async (client) => {
      await client.query(
        `INSERT INTO public.contract_revenue_settings (company_id, user_id, method, revenue_account)
         VALUES ($1, $2, 'successiv', '3095')`,
        [company.companyId, member],
      )
      await client.query(`UPDATE public.contract_revenue_settings SET method = 'fardigstallande' WHERE company_id = $1`, [company.companyId])
      await client.query(`UPDATE public.contract_revenue_settings SET method = 'successiv' WHERE company_id = $1`, [company.companyId])
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO public.contract_revenue_contracts
           (company_id, user_id, name, figures_as_of, contract_value, expected_total_cost)
         VALUES ($1, $2, 'Tak', '2026-12-31', 500000, 400000) RETURNING id`,
        [company.companyId, member],
      )
      await client.query('UPDATE public.contract_revenue_contracts SET costs_to_date = 100000 WHERE id = $1', [rows[0].id])
      const { rows: posted } = await commit(company, draft, booking(1_000), client)
      const bookings = (await client.query('SELECT 1 FROM public.contract_revenue_bookings WHERE journal_entry_id = $1', [draft])).rowCount
      const contractDeleted = (await client.query('DELETE FROM public.contract_revenue_contracts WHERE id = $1', [rows[0].id])).rowCount
      const settingsDeleted = (await client.query('DELETE FROM public.contract_revenue_settings WHERE company_id = $1', [company.companyId])).rowCount
      return { voucher: posted[0].voucher_number, bookings, contractDeleted, settingsDeleted }
    })
    expect(result.voucher).toBeGreaterThan(0)
    expect(result).toMatchObject({ bookings: 1, contractDeleted: 1, settingsDeleted: 1 })
  })
})
