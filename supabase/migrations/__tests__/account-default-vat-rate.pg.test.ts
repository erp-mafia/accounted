import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Locks in the behaviour of chart_of_accounts.default_vat_rate
 * (migration 20260709120000):
 *
 *  - a CHECK constraint keeps the rate to the sats the app understands
 *    (0 / 0.06 / 0.12 / 0.25) or NULL;
 *  - a BEFORE INSERT trigger ships öresavrundning (3740) as momsfri (0) on
 *    every insert path (company seed, SIE import, on-demand backfill, manual
 *    add), so a rounding line never inherits phantom moms;
 *  - the trigger only fills an unset rate, so an explicit choice always wins;
 *  - other accounts keep NULL (today's behaviour: no auto-fill).
 */

async function insertAccount(
  companyId: string,
  userId: string,
  account: {
    number: string
    name: string
    type: string
    balance?: 'debit' | 'credit'
    rate?: number | null
  },
): Promise<number | null> {
  const res = await getPool().query<{ default_vat_rate: string | null }>(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class,
        account_group, account_type, normal_balance, plan_type,
        is_system_account, default_vat_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'full_bas', false, $9)
     RETURNING default_vat_rate`,
    [
      userId,
      companyId,
      account.number,
      account.name,
      Number(account.number[0]),
      account.number.slice(0, 2),
      account.type,
      account.balance ?? 'debit',
      account.rate ?? null,
    ],
  )
  const raw = res.rows[0].default_vat_rate
  return raw === null ? null : Number(raw)
}

describe('chart_of_accounts.default_vat_rate', () => {
  it('ships öresavrundning (3740) as momsfri (0) when the rate is unset', async () => {
    const { companyId, userId } = await seedCompany()
    const rate = await insertAccount(companyId, userId, {
      number: '3740',
      name: 'Öres- och kronutjämning',
      type: 'revenue',
    })
    expect(rate).toBe(0)
  })

  it('keeps an explicit rate on 3740 (trigger only fills an unset rate)', async () => {
    const { companyId, userId } = await seedCompany()
    const rate = await insertAccount(companyId, userId, {
      number: '3740',
      name: 'Öres- och kronutjämning',
      type: 'revenue',
      rate: 0.25,
    })
    expect(rate).toBe(0.25)
  })

  it('leaves other accounts with no default (NULL)', async () => {
    const { companyId, userId } = await seedCompany()
    const rate = await insertAccount(companyId, userId, {
      number: '5010',
      name: 'Lokalhyra',
      type: 'expense',
    })
    expect(rate).toBeNull()
  })

  it('accepts every allowed sats', async () => {
    const { companyId, userId } = await seedCompany()
    for (const [i, r] of [0, 0.06, 0.12, 0.25].entries()) {
      const rate = await insertAccount(companyId, userId, {
        number: `60${i}0`,
        name: `Konto ${i}`,
        type: 'expense',
        rate: r,
      })
      expect(rate).toBe(r)
    }
  })

  it('rejects a rate outside the allowed set (CHECK constraint)', async () => {
    const { companyId, userId } = await seedCompany()
    await expect(
      insertAccount(companyId, userId, {
        number: '5020',
        name: 'Felaktig sats',
        type: 'expense',
        rate: 0.2,
      }),
    ).rejects.toThrow()
  })
})
