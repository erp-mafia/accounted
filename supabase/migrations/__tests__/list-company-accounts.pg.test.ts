import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Locks the behavior of public.list_company_accounts (20260723170000,
 * reordered in 20260911190000): the single-round-trip replacement for the
 * paged fetchAllRows chart-of-accounts fetch in app/api/bookkeeping/accounts.
 *
 * The route treats the RPC result as a drop-in for select('*') ordered by
 * account_number, so the critical properties are:
 *   - filter parity: p_active_only / p_account_class mirror the route's
 *     .eq('is_active', true) / .eq('account_class', n) filters
 *   - ordering: account_number (the BAS sequence), never sort_order, which
 *     is 0 on every seeded account
 *   - field-set parity: every element carries the exact column set of
 *     chart_of_accounts (to_json of the whole row), so response shapes
 *     do not change when the route switches paths
 *   - SECURITY INVOKER: RLS still gates rows for non-members
 */

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20260911190000_list_company_accounts_account_number_order.sql',
  ),
  'utf8',
)

interface AccountJson {
  id: string
  account_number: string
  account_class: number
  sort_order: number
  is_active: boolean
  [key: string]: unknown
}

async function callRpc(
  companyId: string,
  activeOnly: boolean = true,
  accountClass: number | null = null,
): Promise<AccountJson[]> {
  const res = await getPool().query<{ result: AccountJson[] }>(
    `SELECT public.list_company_accounts($1::uuid, $2::boolean, $3::integer) AS result`,
    [companyId, activeOnly, accountClass],
  )
  return res.rows[0]!.result
}

async function seedChart(companyId: string): Promise<void> {
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [
    companyId,
  ])
}

async function insertAccount(params: {
  userId: string
  companyId: string
  accountNumber: string
  accountClass: number
  isActive?: boolean
  sortOrder?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (id, user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'expense', 'debit', $8, $9)`,
    [
      id,
      params.userId,
      params.companyId,
      params.accountNumber,
      `Testkonto ${params.accountNumber}`,
      params.accountClass,
      params.accountNumber.substring(0, 2),
      params.isActive ?? true,
      params.sortOrder ?? 0,
    ],
  )
  return id
}

describe('list_company_accounts: filtering', () => {
  it('returns only active rows by default and includes inactive with p_active_only=false', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId)
    const inactiveId = await insertAccount({
      userId,
      companyId,
      accountNumber: '9998',
      accountClass: 8,
      isActive: false,
    })

    const activeRows = await callRpc(companyId)
    expect(activeRows.length).toBeGreaterThan(0)
    expect(activeRows.every((r) => r.is_active)).toBe(true)
    expect(activeRows.some((r) => r.id === inactiveId)).toBe(false)

    const allRows = await callRpc(companyId, false)
    expect(allRows.some((r) => r.id === inactiveId)).toBe(true)
    expect(allRows.length).toBe(activeRows.length + 1)
  })

  it('filters by p_account_class', async () => {
    const { companyId } = await seedCompany()
    await seedChart(companyId)

    const class3 = await callRpc(companyId, true, 3)
    expect(class3.length).toBeGreaterThan(0)
    expect(class3.every((r) => r.account_class === 3)).toBe(true)

    const expected = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.chart_of_accounts
        WHERE company_id = $1 AND is_active AND account_class = 3`,
      [companyId],
    )
    expect(class3.length).toBe(Number(expected.rows[0]!.n))
  })

  it('returns [] (not NULL) for an unknown company id', async () => {
    const rows = await callRpc(randomUUID())
    expect(rows).toEqual([])
  })
})

describe('list_company_accounts: ordering', () => {
  it('orders by account_number, ignoring sort_order', async () => {
    const { userId, companyId } = await seedCompany()
    // The seed leaves sort_order at 0 on every system account, the prod shape
    // that made the old (sort_order, id) order put the seeded block first.
    await seedChart(companyId)
    const seededSortOrders = await getPool().query<{ sort_order: number }>(
      `SELECT DISTINCT sort_order FROM public.chart_of_accounts
        WHERE company_id = $1 AND is_system_account`,
      [companyId],
    )
    expect(seededSortOrders.rows.map((r) => r.sort_order)).toEqual([0])

    // User-added accounts carry sort_order = number, as the create routes
    // write it, plus one with a sort_order far out of sequence and an imported
    // five-digit sub-account that must land directly after its parent 1930.
    await insertAccount({ userId, companyId, accountNumber: '1110', accountClass: 1, sortOrder: 1110 })
    await insertAccount({ userId, companyId, accountNumber: '6540', accountClass: 6, sortOrder: 6540 })
    await insertAccount({ userId, companyId, accountNumber: '1220', accountClass: 1, sortOrder: 99999 })
    await insertAccount({ userId, companyId, accountNumber: '19301', accountClass: 1, sortOrder: 19301 })

    const rows = await callRpc(companyId)
    const numbers = rows.map((r) => r.account_number)
    expect(numbers.slice(0, 3)).toEqual(['1110', '1220', '1510'])
    expect(numbers.indexOf('19301')).toBe(numbers.indexOf('1930') + 1)
    expect(numbers.indexOf('6540')).toBe(numbers.indexOf('6530') + 1)

    const expected = await getPool().query<{ account_number: string }>(
      `SELECT account_number FROM public.chart_of_accounts
        WHERE company_id = $1 AND is_active
        ORDER BY account_number`,
      [companyId],
    )
    expect(numbers).toEqual(expected.rows.map((r) => r.account_number))
  })

  it('keeps account_number order inside a class filter', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId)
    await insertAccount({ userId, companyId, accountNumber: '5000', accountClass: 5, sortOrder: 5000 })

    const numbers = (await callRpc(companyId, true, 5)).map((r) => r.account_number)
    expect(numbers[0]).toBe('5000')
    expect(numbers).toEqual([...numbers].sort())
  })
})

describe('list_company_accounts: select(*) parity', () => {
  it('each element carries the exact column set of chart_of_accounts', async () => {
    const { companyId } = await seedCompany()
    await seedChart(companyId)

    const rows = await callRpc(companyId)
    expect(rows.length).toBeGreaterThan(0)

    const cols = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chart_of_accounts'`,
    )
    const expectedKeys = cols.rows.map((r) => r.column_name).sort()
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(expectedKeys)
    }
  })
})

describe('list_company_accounts: security', () => {
  it('is SECURITY INVOKER: a non-member sees zero rows through RLS', async () => {
    const { companyId } = await seedCompany()
    await seedChart(companyId)
    const outsiderId = await insertAuthUser()

    const rows = await withUserContext(outsiderId, async (client) => {
      const res = await client.query<{ result: AccountJson[] }>(
        `SELECT public.list_company_accounts($1::uuid) AS result`,
        [companyId],
      )
      return res.rows[0]!.result
    })
    expect(rows).toEqual([])
  })

  it('a member sees the company chart through the same RLS policy', async () => {
    const { userId, companyId } = await seedCompany()
    await seedChart(companyId)

    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ result: AccountJson[] }>(
        `SELECT public.list_company_accounts($1::uuid) AS result`,
        [companyId],
      )
      return res.rows[0]!.result
    })
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('list_company_accounts: migration idempotency', () => {
  it('re-executing the migration SQL succeeds and the function still works', async () => {
    await getPool().query(MIGRATION_SQL)

    const { companyId } = await seedCompany()
    await seedChart(companyId)
    const rows = await callRpc(companyId)
    expect(rows.length).toBeGreaterThan(0)
  })
})
