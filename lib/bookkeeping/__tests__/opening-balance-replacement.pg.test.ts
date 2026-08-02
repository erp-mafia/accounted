import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompanyMember,
  seedCompany,
} from '@/tests/pg/fixtures'

type ReplacementResult = {
  new_entry_id: string
  storno_entry_id: string
  new_voucher_number: number
  storno_voucher_number: number
}

type SeededOpeningBalance = {
  oldEntryId: string
  lines: Array<Record<string, unknown>>
}

async function seedOpeningBalance(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  debit?: number
  link?: boolean
}): Promise<SeededOpeningBalance> {
  const amount = params.debit ?? 100
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_type, normal_balance, is_active)
     VALUES
       ($1, $2, '1930', 'Bankkonto', 1, 'asset', 'debit', true),
       ($1, $2, '2010', 'Eget kapital', 2, 'equity', 'credit', true)
     ON CONFLICT (company_id, account_number) DO NOTHING`,
    [params.userId, params.companyId],
  )
  const accounts = await getPool().query<{ id: string; account_number: string }>(
    `SELECT id, account_number
       FROM public.chart_of_accounts
      WHERE company_id = $1
        AND account_number = ANY($2::text[])
      ORDER BY account_number`,
    [params.companyId, ['1930', '2010']],
  )
  const accountIds = new Map(accounts.rows.map((account) => [account.account_number, account.id]))

  expect(accountIds.get('1930')).toBeTruthy()
  expect(accountIds.get('2010')).toBeTruthy()

  const oldEntryId = randomUUID()
  const voucher = await getPool().query<{ next_number: number }>(
    `SELECT COALESCE(max(voucher_number), 0)::int + 1 AS next_number
       FROM public.journal_entries
      WHERE company_id = $1
        AND fiscal_period_id = $2
        AND voucher_series = 'A'`,
    [params.companyId, params.fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number,
        voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-01-01',
             'Old opening balance', 'opening_balance', 'posted')`,
    [
      oldEntryId,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      voucher.rows[0]!.next_number,
    ],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, account_id, debit_amount,
        credit_amount, currency, dimensions, sort_order)
     VALUES
       ($1, '1930', $2, $4, 0, 'SEK', '{}'::jsonb, 0),
       ($1, '2010', $3, 0, $4, 'SEK', '{}'::jsonb, 1)`,
    [oldEntryId, accountIds.get('1930'), accountIds.get('2010'), amount],
  )
  await getPool().query(
     `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, 'A', $4)
     ON CONFLICT (company_id, fiscal_period_id, voucher_series)
     DO UPDATE SET last_number = GREATEST(public.voucher_sequences.last_number, $4)`,
    [
      params.companyId,
      params.userId,
      params.fiscalPeriodId,
      voucher.rows[0]!.next_number,
    ],
  )
  if (params.link !== false) {
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $1,
              opening_balances_set = true
        WHERE id = $2`,
      [oldEntryId, params.fiscalPeriodId],
    )
  }

  return {
    oldEntryId,
    lines: [
      {
        account_number: '1930',
        account_id: accountIds.get('1930'),
        debit_amount: 150,
        credit_amount: 0,
        currency: 'SEK',
        amount_in_currency: null,
        exchange_rate: null,
        line_description: 'IB 1930',
        tax_code: null,
        dimensions: {},
        sort_order: 0,
      },
      {
        account_number: '2010',
        account_id: accountIds.get('2010'),
        debit_amount: 0,
        credit_amount: 150,
        currency: 'SEK',
        amount_in_currency: null,
        exchange_rate: null,
        line_description: 'IB 2010',
        tax_code: null,
        dimensions: {},
        sort_order: 1,
      },
    ],
  }
}

async function setRole(
  client: PoolClient,
  role: 'authenticated' | 'service_role',
  userId?: string,
): Promise<void> {
  const claims = userId
    ? { sub: userId, role }
    : { role }
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
  await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role])
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
  const roleStatements = {
    authenticated: 'SET LOCAL ROLE authenticated',
    service_role: 'SET LOCAL ROLE service_role',
  } as const
  await client.query(roleStatements[role])
}

async function runAs<T>(
  role: 'authenticated' | 'service_role',
  userId: string | undefined,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await setRole(client, role, userId)
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function callReplacement(
  client: PoolClient,
  params: {
    companyId: string
    fiscalPeriodId: string
    expectedOldEntryId: string
    userId: string
    lines: Array<Record<string, unknown>>
  },
): Promise<ReplacementResult> {
  const result = await client.query<ReplacementResult>(
    `SELECT * FROM public.commit_opening_balance_replacement(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-01-01'::date,
       'Replacement opening balance', 'A', $5::jsonb, NULL, NULL
     )`,
    [
      params.companyId,
      params.fiscalPeriodId,
      params.expectedOldEntryId,
      params.userId,
      JSON.stringify(params.lines),
    ],
  )
  return result.rows[0]!
}

async function expectUnchanged(params: {
  companyId: string
  fiscalPeriodId: string
  oldEntryId: string
  entryCount: number
  lastNumber: number
}): Promise<void> {
  const state = await getPool().query<{
    opening_balance_entry_id: string | null
    opening_balances_set: boolean
    old_status: string
    entry_count: number
    last_number: number
  }>(
    `SELECT fp.opening_balance_entry_id,
            fp.opening_balances_set,
            old.status AS old_status,
            (SELECT count(*)::int
               FROM public.journal_entries je
              WHERE je.company_id = $1) AS entry_count,
            sequence.last_number
       FROM public.fiscal_periods fp
       JOIN public.journal_entries old ON old.id = $2
       JOIN public.voucher_sequences sequence
         ON sequence.company_id = $1
        AND sequence.fiscal_period_id = fp.id
        AND sequence.voucher_series = 'A'
      WHERE fp.id = $3`,
    [params.companyId, params.oldEntryId, params.fiscalPeriodId],
  )
  expect(state.rows[0]).toEqual({
    opening_balance_entry_id: params.oldEntryId,
    opening_balances_set: true,
    old_status: 'posted',
    entry_count: params.entryCount,
    last_number: params.lastNumber,
  })
}

describe('commit_opening_balance_replacement', () => {
  it('atomically replaces the IB for a member without a duplicate balance', async () => {
    const { userId: ownerId, companyId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const seeded = await seedOpeningBalance({
      userId: ownerId,
      companyId,
      fiscalPeriodId,
    })

    const outcome = await runAs('authenticated', memberId, (client) => callReplacement(client, {
      companyId,
      fiscalPeriodId,
      expectedOldEntryId: seeded.oldEntryId,
      userId: memberId,
      lines: seeded.lines,
    }))

    const state = await getPool().query<{
      id: string
      status: string
      source_type: string
      reverses_id: string | null
      reversed_by_id: string | null
      user_id: string
    }>(
      `SELECT id, status, source_type, reverses_id, reversed_by_id, user_id
         FROM public.journal_entries
        WHERE id = ANY($1::uuid[])`,
      [[seeded.oldEntryId, outcome.new_entry_id, outcome.storno_entry_id]],
    )
    expect(state.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: seeded.oldEntryId,
        status: 'reversed',
        reversed_by_id: outcome.storno_entry_id,
      }),
      expect.objectContaining({
        id: outcome.new_entry_id,
        status: 'posted',
        source_type: 'opening_balance',
        user_id: memberId,
      }),
      expect.objectContaining({
        id: outcome.storno_entry_id,
        status: 'posted',
        source_type: 'storno',
        reverses_id: seeded.oldEntryId,
        user_id: memberId,
      }),
    ]))

    const period = await getPool().query<{ opening_balance_entry_id: string }>(
      `SELECT opening_balance_entry_id
         FROM public.fiscal_periods
        WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(period.rows[0]!.opening_balance_entry_id).toBe(outcome.new_entry_id)

    const net = await getPool().query<{ account_number: string; amount: number }>(
      `SELECT line.account_number,
              sum(line.debit_amount - line.credit_amount)::float8 AS amount
         FROM public.journal_entry_lines line
         JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
        WHERE entry.id = ANY($1::uuid[])
          AND entry.status IN ('posted', 'reversed')
        GROUP BY line.account_number
        ORDER BY line.account_number`,
      [[seeded.oldEntryId, outcome.new_entry_id, outcome.storno_entry_id]],
    )
    expect(net.rows).toEqual([
      { account_number: '1930', amount: 150 },
      { account_number: '2010', amount: -150 },
    ])
  })

  it('supports the service-role SIE path with a scoped member actor', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const seeded = await seedOpeningBalance({ userId, companyId, fiscalPeriodId })

    const outcome = await runAs('service_role', undefined, (client) => callReplacement(client, {
      companyId,
      fiscalPeriodId,
      expectedOldEntryId: seeded.oldEntryId,
      userId,
      lines: seeded.lines,
    }))

    expect(outcome.new_entry_id).toBeTruthy()
    expect(outcome.storno_entry_id).toBeTruthy()
    expect(outcome.new_voucher_number).toBe(2)
    expect(outcome.storno_voucher_number).toBe(3)
  })

  it('rejects a viewer before writing any replacement entries', async () => {
    const { userId: ownerId, companyId, fiscalPeriodId } = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    const seeded = await seedOpeningBalance({
      userId: ownerId,
      companyId,
      fiscalPeriodId,
    })
    const before = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )

    await expect(runAs('authenticated', viewerId, (client) => callReplacement(client, {
      companyId,
      fiscalPeriodId,
      expectedOldEntryId: seeded.oldEntryId,
      userId: viewerId,
      lines: seeded.lines,
    }))).rejects.toMatchObject({ code: '42501' })

    await expectUnchanged({
      companyId,
      fiscalPeriodId,
      oldEntryId: seeded.oldEntryId,
      entryCount: before.rows[0]!.count,
      lastNumber: 1,
    })
  })

  it('rejects authenticated and service-role writes to an archived company', async () => {
    const { userId: ownerId, companyId, fiscalPeriodId } = await seedCompany()
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    const seeded = await seedOpeningBalance({
      userId: ownerId,
      companyId,
      fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.companies SET archived_at = now() WHERE id = $1`,
      [companyId],
    )
    const before = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )

    const callers: Array<{
      role: 'authenticated' | 'service_role'
      jwtUserId: string | undefined
    }> = [
      { role: 'authenticated', jwtUserId: memberId },
      { role: 'service_role', jwtUserId: undefined },
    ]

    for (const caller of callers) {
      await expect(runAs(caller.role, caller.jwtUserId, (client) => callReplacement(client, {
        companyId,
        fiscalPeriodId,
        expectedOldEntryId: seeded.oldEntryId,
        userId: memberId,
        lines: seeded.lines,
      }))).rejects.toMatchObject({ code: '42501' })

      await expectUnchanged({
        companyId,
        fiscalPeriodId,
        oldEntryId: seeded.oldEntryId,
        entryCount: before.rows[0]!.count,
        lastNumber: 1,
      })
    }
  })

  it('rejects a locked period before writing any replacement entries', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const seeded = await seedOpeningBalance({ userId, companyId, fiscalPeriodId })
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fiscalPeriodId],
    )
    const before = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )

    await expect(runAs('authenticated', userId, (client) => callReplacement(client, {
      companyId,
      fiscalPeriodId,
      expectedOldEntryId: seeded.oldEntryId,
      userId,
      lines: seeded.lines,
    }))).rejects.toThrow(/locked\/closed fiscal period/)

    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = NULL WHERE id = $1`,
      [fiscalPeriodId],
    )
    await expectUnchanged({
      companyId,
      fiscalPeriodId,
      oldEntryId: seeded.oldEntryId,
      entryCount: before.rows[0]!.count,
      lastNumber: 1,
    })
  })

  it('rejects a company lock date before writing any replacement entries', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const seeded = await seedOpeningBalance({ userId, companyId, fiscalPeriodId })
    await getPool().query(
      `INSERT INTO public.company_settings
         (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2026-01-01')
       ON CONFLICT (company_id)
       DO UPDATE SET bookkeeping_locked_through = EXCLUDED.bookkeeping_locked_through`,
      [userId, companyId],
    )
    const before = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )

    await expect(runAs('authenticated', userId, (client) => callReplacement(client, {
      companyId,
      fiscalPeriodId,
      expectedOldEntryId: seeded.oldEntryId,
      userId,
      lines: seeded.lines,
    }))).rejects.toThrow(/Bookkeeping is locked through/)

    await getPool().query(
      `UPDATE public.company_settings
          SET bookkeeping_locked_through = NULL
        WHERE company_id = $1`,
      [companyId],
    )
    await expectUnchanged({
      companyId,
      fiscalPeriodId,
      oldEntryId: seeded.oldEntryId,
      entryCount: before.rows[0]!.count,
      lastNumber: 1,
    })
  })

  it('uses compare-and-swap protection when the period pointer changed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const seeded = await seedOpeningBalance({ userId, companyId, fiscalPeriodId })
    const competing = await seedOpeningBalance({
      userId,
      companyId,
      fiscalPeriodId,
      debit: 125,
      link: false,
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balances_set = false
        WHERE id = $1`,
      [fiscalPeriodId],
    )
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $1,
              opening_balances_set = true
        WHERE id = $2`,
      [competing.oldEntryId, fiscalPeriodId],
    )
    const before = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )

    await expect(runAs('authenticated', userId, (client) => callReplacement(client, {
      companyId,
      fiscalPeriodId,
      expectedOldEntryId: seeded.oldEntryId,
      userId,
      lines: seeded.lines,
    }))).rejects.toMatchObject({ code: '40001' })

    const state = await getPool().query<{
      opening_balance_entry_id: string
      original_status: string
      entry_count: number
    }>(
      `SELECT fp.opening_balance_entry_id,
              original.status AS original_status,
              (SELECT count(*)::int FROM public.journal_entries WHERE company_id = $1) AS entry_count
         FROM public.fiscal_periods fp
         JOIN public.journal_entries original ON original.id = $2
        WHERE fp.id = $3`,
      [companyId, seeded.oldEntryId, fiscalPeriodId],
    )
    expect(state.rows[0]).toEqual({
      opening_balance_entry_id: competing.oldEntryId,
      original_status: 'posted',
      entry_count: before.rows[0]!.count,
    })
  })

  it('rolls back vouchers, storno, pointer, status, and sequence on a late failure', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const seeded = await seedOpeningBalance({ userId, companyId, fiscalPeriodId })
    const before = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    const client = await getClient()

    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE FUNCTION public.test_fail_atomic_ib_pointer_swap()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
          IF NEW.opening_balance_entry_id IS DISTINCT FROM OLD.opening_balance_entry_id THEN
            RAISE EXCEPTION 'forced late pointer failure';
          END IF;
          RETURN NEW;
        END;
        $trigger$
      `)
      await client.query(`
        CREATE TRIGGER test_fail_atomic_ib_pointer_swap
        BEFORE UPDATE ON public.fiscal_periods
        FOR EACH ROW
        EXECUTE FUNCTION public.test_fail_atomic_ib_pointer_swap()
      `)
      await setRole(client, 'authenticated', userId)
      await client.query('SAVEPOINT before_replacement')

      await expect(callReplacement(client, {
        companyId,
        fiscalPeriodId,
        expectedOldEntryId: seeded.oldEntryId,
        userId,
        lines: seeded.lines,
      })).rejects.toThrow(/forced late pointer failure/)

      await client.query('ROLLBACK TO SAVEPOINT before_replacement')
      await client.query('RESET ROLE')

      const state = await client.query<{
        opening_balance_entry_id: string
        opening_balances_set: boolean
        old_status: string
        entry_count: number
        last_number: number
      }>(
        `SELECT fp.opening_balance_entry_id,
                fp.opening_balances_set,
                old.status AS old_status,
                (SELECT count(*)::int FROM public.journal_entries WHERE company_id = $1) AS entry_count,
                sequence.last_number
           FROM public.fiscal_periods fp
           JOIN public.journal_entries old ON old.id = $2
           JOIN public.voucher_sequences sequence
             ON sequence.company_id = $1
            AND sequence.fiscal_period_id = fp.id
            AND sequence.voucher_series = 'A'
          WHERE fp.id = $3`,
        [companyId, seeded.oldEntryId, fiscalPeriodId],
      )
      expect(state.rows[0]).toEqual({
        opening_balance_entry_id: seeded.oldEntryId,
        opening_balances_set: true,
        old_status: 'posted',
        entry_count: before.rows[0]!.count,
        last_number: 1,
      })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('grants execution only to authenticated and service-role callers', async () => {
    const privileges = await getPool().query<{
      authenticated_can: boolean
      service_role_can: boolean
      anon_can: boolean
    }>(
      `SELECT
         has_function_privilege(
           'authenticated',
           'public.commit_opening_balance_replacement(uuid,uuid,uuid,uuid,date,text,text,jsonb,text,text)',
           'EXECUTE'
         ) AS authenticated_can,
         has_function_privilege(
           'service_role',
           'public.commit_opening_balance_replacement(uuid,uuid,uuid,uuid,date,text,text,jsonb,text,text)',
           'EXECUTE'
         ) AS service_role_can,
         has_function_privilege(
           'anon',
           'public.commit_opening_balance_replacement(uuid,uuid,uuid,uuid,date,text,text,jsonb,text,text)',
           'EXECUTE'
         ) AS anon_can`,
    )
    expect(privileges.rows[0]).toEqual({
      authenticated_can: true,
      service_role_can: true,
      anon_can: false,
    })
  })
})
