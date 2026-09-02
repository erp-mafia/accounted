import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260901210000_expense_claims: RLS (member SELECT,
// owner/admin/member writes, viewers read-only, strangers see nothing) and
// the CHECK constraints (vat_sek < amount_sek, paid requires a payout batch,
// cash/liability account whitelists on payout batches).

async function insertClaim(
  companyId: string,
  userId: string,
  overrides: Partial<{ amountSek: number; vatSek: number }> = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account)
     VALUES ($1, $2, $3, 'Ägare', 'USB-hubb', '2026-08-25', $4, $5, '5410')`,
    [id, companyId, userId, overrides.amountSek ?? 500, overrides.vatSek ?? 100],
  )
  return id
}

describe('expense_claims RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const claimId = await insertClaim(companyId, userId)
    const stranger = await insertAuthUser()

    const memberView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.expense_claims WHERE id = $1`, [claimId]),
    )
    expect(memberView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.expense_claims WHERE id = $1`, [claimId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('lets viewers read but not register claims', async () => {
    const { userId, companyId } = await seedCompany()
    const claimId = await insertClaim(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const viewerRead = await withUserContext(viewer, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.expense_claims WHERE id = $1`, [claimId]),
    )
    expect(viewerRead.rows).toHaveLength(1)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.expense_claims
             (company_id, user_id, claimant_name, description, expense_date, amount_sek, expense_account)
           VALUES ($1, $2, 'Ägare', 'USB-hubb', '2026-08-25', 500, '5410')`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('viewers cannot update or delete claims', async () => {
    const { userId, companyId } = await seedCompany()
    const claimId = await insertClaim(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    // RLS filters the rows out of UPDATE/DELETE scope: 0 rows affected.
    const upd = await withUserContext(viewer, (client) =>
      client.query(`UPDATE public.expense_claims SET description = 'x' WHERE id = $1`, [claimId]),
    )
    expect(upd.rowCount).toBe(0)
    const der = await withUserContext(viewer, (client) =>
      client.query(`DELETE FROM public.expense_claims WHERE id = $1`, [claimId]),
    )
    expect(der.rowCount).toBe(0)

    const still = await getPool().query(`SELECT description FROM public.expense_claims WHERE id = $1`, [claimId])
    expect(still.rows[0].description).toBe('USB-hubb')
  })

  it('members cannot write into another company', async () => {
    const { userId } = await seedCompany()
    const other = await seedCompany()

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.expense_claims
             (company_id, user_id, claimant_name, description, expense_date, amount_sek, expense_account)
           VALUES ($1, $2, 'Ägare', 'USB-hubb', '2026-08-25', 500, '5410')`,
          [other.companyId, userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })
})

describe('expense_claims constraints', () => {
  it('rejects vat_sek >= amount_sek', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertClaim(companyId, userId, { amountSek: 100, vatSek: 100 })).rejects.toThrow(
      /check constraint/i,
    )
  })

  it('rejects status paid without a payout batch', async () => {
    const { userId, companyId } = await seedCompany()
    const claimId = await insertClaim(companyId, userId)
    await expect(
      getPool().query(`UPDATE public.expense_claims SET status = 'paid' WHERE id = $1`, [claimId]),
    ).rejects.toThrow(/check/i)
  })

  it('refuses a payout batch from another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const claimId = await insertClaim(a.companyId, a.userId)

    // A batch that exists, but in the other company.
    const foreign = await getPool().query<{ id: string }>(
      `INSERT INTO public.expense_payout_batches
         (company_id, user_id, claimant_name, payout_date, cash_account, liability_account, total_sek)
       VALUES ($1, $2, 'Ägare', '2026-08-31', '1930', '2893', 500) RETURNING id`,
      [b.companyId, b.userId],
    )

    await expect(
      getPool().query(
        `UPDATE public.expense_claims SET status = 'paid', payout_batch_id = $1 WHERE id = $2`,
        [foreign.rows[0].id, claimId],
      ),
    ).rejects.toThrow(/foreign key/)

    // The same shape inside the claim's own company is accepted.
    const own = await getPool().query<{ id: string }>(
      `INSERT INTO public.expense_payout_batches
         (company_id, user_id, claimant_name, payout_date, cash_account, liability_account, total_sek)
       VALUES ($1, $2, 'Ägare', '2026-08-31', '1930', '2893', 500) RETURNING id`,
      [a.companyId, a.userId],
    )
    const ok = await getPool().query(
      `UPDATE public.expense_claims SET status = 'paid', payout_batch_id = $1 WHERE id = $2`,
      [own.rows[0].id, claimId],
    )
    expect(ok.rowCount).toBe(1)
  })

  it('rejects a non-19xx cash account and an off-list liability account on batches', async () => {
    const { userId, companyId } = await seedCompany()
    const insertBatch = (cashAccount: string, liabilityAccount: string) =>
      getPool().query(
        `INSERT INTO public.expense_payout_batches
           (company_id, user_id, claimant_name, payout_date, cash_account, liability_account, total_sek)
         VALUES ($1, $2, 'Ägare', '2026-08-31', $3, $4, 500)`,
        [companyId, userId, cashAccount, liabilityAccount],
      )
    await expect(insertBatch('2440', '2893')).rejects.toThrow(/cash_account/)
    await expect(insertBatch('1930', '2440')).rejects.toThrow(/liability_account/)
    await expect(insertBatch('1930', '2893')).resolves.toBeTruthy()
  })
})
