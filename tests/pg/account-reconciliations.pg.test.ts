import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260823140000_account_reconciliations: RLS (member
// SELECT, owner/admin/member writes with signed_by = auth.uid(), viewers
// read-only, no DELETE policy), the account_key CHECK, the one-active-per-date
// partial unique index (a reopened row frees the slot), and the reopen pair
// CHECK.

async function insertSignoff(
  companyId: string,
  signedBy: string,
  overrides: { accountKey?: string; throughDate?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.account_reconciliations
       (id, company_id, account_key, through_date, external_balance, ledger_balance, unexplained_difference, signed_by)
     VALUES ($1, $2, $3, $4, 100.00, 100.00, 0, $5)`,
    [id, companyId, overrides.accountKey ?? 'skattekonto', overrides.throughDate ?? '2026-07-31', signedBy],
  )
  return id
}

describe('account_reconciliations RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertSignoff(companyId, userId)
    const stranger = await insertAuthUser()

    const ownerView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.account_reconciliations WHERE id = $1`, [rowId]),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.account_reconciliations WHERE id = $1`, [rowId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('lets viewers read but not sign', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertSignoff(companyId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const viewerRead = await withUserContext(viewer, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.account_reconciliations WHERE id = $1`, [rowId]),
    )
    expect(viewerRead.rows).toHaveLength(1)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.account_reconciliations (company_id, account_key, through_date, signed_by)
           VALUES ($1, 'skattekonto', '2026-08-31', $2)`,
          [companyId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets members sign as themselves but not as someone else', async () => {
    const { userId: owner, companyId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const inserted = await withUserContext(member, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO public.account_reconciliations (company_id, account_key, through_date, signed_by)
         VALUES ($1, 'skattekonto', '2026-08-31', $2) RETURNING id`,
        [companyId, member],
      ),
    )
    expect(inserted.rows).toHaveLength(1)

    await expect(
      withUserContext(member, (client) =>
        client.query(
          `INSERT INTO public.account_reconciliations (company_id, account_key, through_date, signed_by)
           VALUES ($1, 'skattekonto', '2026-09-30', $2)`,
          [companyId, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets members stamp a reopen but never delete', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertSignoff(companyId, userId)

    const reopened = await withUserContext(userId, (client) =>
      client.query<{ id: string; reopened_at: string | null }>(
        `UPDATE public.account_reconciliations
            SET reopened_at = NOW(), reopened_by = $2, reopen_reason = 'sen rad'
          WHERE id = $1 AND reopened_at IS NULL
          RETURNING id, reopened_at`,
        [rowId, userId],
      ),
    )
    expect(reopened.rows).toHaveLength(1)
    expect(reopened.rows[0].reopened_at).not.toBeNull()

    // No DELETE policy: the statement succeeds but touches nothing.
    const deleted = await withUserContext(userId, (client) =>
      client.query(`DELETE FROM public.account_reconciliations WHERE id = $1`, [rowId]),
    )
    expect(deleted.rowCount).toBe(0)
  })
})

describe('account_reconciliations constraints', () => {
  it('rejects an account_key that is not bank:<uuid>, skattekonto or manual:NNNN', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertSignoff(companyId, userId, { accountKey: '1930' })).rejects.toThrow(/account_key/i)
    await expect(insertSignoff(companyId, userId, { accountKey: 'bank:not-a-uuid' })).rejects.toThrow(/account_key/i)
    await expect(insertSignoff(companyId, userId, { accountKey: `bank:${randomUUID()}` })).resolves.toBeTruthy()
    await expect(insertSignoff(companyId, userId, { accountKey: 'manual:1910' })).resolves.toBeTruthy()
  })

  it('allows one active sign-off per account and date; a reopened one frees the slot', async () => {
    const { userId, companyId } = await seedCompany()
    const first = await insertSignoff(companyId, userId, { throughDate: '2026-07-31' })
    await expect(insertSignoff(companyId, userId, { throughDate: '2026-07-31' })).rejects.toThrow(
      /ux_account_reconciliations_active|duplicate key/i,
    )
    // A different account on the same date is fine.
    await expect(
      insertSignoff(companyId, userId, { accountKey: `bank:${randomUUID()}`, throughDate: '2026-07-31' }),
    ).resolves.toBeTruthy()

    await getPool().query(
      `UPDATE public.account_reconciliations SET reopened_at = NOW(), reopened_by = $2 WHERE id = $1`,
      [first, userId],
    )
    await expect(insertSignoff(companyId, userId, { throughDate: '2026-07-31' })).resolves.toBeTruthy()
  })

  it('requires reopened_at and reopened_by together', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertSignoff(companyId, userId)
    await expect(
      getPool().query(`UPDATE public.account_reconciliations SET reopened_at = NOW() WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/account_reconciliations_reopen_pair/i)
  })
})
