import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'

/**
 * 20260915160100_association_distributions.sql: RLS on the two tables
 * (members read, owner/admin/member write as themselves, no DELETE), the
 * allocation guard (allocations must equal the total before the row leaves
 * 'decided', and are frozen afterwards) and the status/verifikat CHECK.
 */

async function insertMember(companyId: string, userId: string, memberNumber: string): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.association_members (company_id, user_id, member_number, name, admitted_on)
     VALUES ($1, $2, $3, 'Medlem', '2026-01-10') RETURNING id`,
    [companyId, userId, memberNumber],
  )
  return res.rows[0].id
}

async function insertDistribution(
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  total = 1000,
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.association_distributions
       (company_id, user_id, kind, fiscal_period_id, decision_date, decided_by, allocation_basis, total_amount)
     VALUES ($1, $2, 'insats_dividend', $3, '2026-05-20', 'stamma', 'contributions', $4) RETURNING id`,
    [companyId, userId, fiscalPeriodId, total],
  )
  return res.rows[0].id
}

async function insertAllocation(
  companyId: string,
  userId: string,
  distributionId: string,
  memberId: string,
  amount: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.association_distribution_allocations
       (company_id, user_id, distribution_id, member_id, basis_value, amount)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [companyId, userId, distributionId, memberId, amount],
  )
}

describe('association distributions: RLS', () => {
  it('lets company members read, strangers see nothing, viewers cannot write, and nobody deletes', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const distributionId = await insertDistribution(companyId, userId, fiscalPeriodId)
    const stranger = await insertAuthUser()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const own = await withUserContext(userId, (c) =>
      c.query(`SELECT id FROM public.association_distributions WHERE id = $1`, [distributionId]),
    )
    expect(own.rows).toHaveLength(1)
    const other = await withUserContext(stranger, (c) =>
      c.query(`SELECT id FROM public.association_distributions WHERE id = $1`, [distributionId]),
    )
    expect(other.rows).toHaveLength(0)
    const viewerRead = await withUserContext(viewer, (c) =>
      c.query(`SELECT id FROM public.association_distributions WHERE id = $1`, [distributionId]),
    )
    expect(viewerRead.rows).toHaveLength(1)
    await expect(
      withUserContext(viewer, (c) =>
        c.query(
          `INSERT INTO public.association_distributions
             (company_id, user_id, kind, fiscal_period_id, decision_date, decided_by, allocation_basis, total_amount)
           VALUES ($1, $2, 'cooperative_rebate', $3, '2026-05-20', 'board', 'turnover', 100)`,
          [companyId, viewer, fiscalPeriodId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (c) =>
        c.query(`DELETE FROM public.association_distributions WHERE id = $1`, [distributionId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const memberId = await insertMember(companyId, userId, '1')
    await insertAllocation(companyId, userId, distributionId, memberId, 1000)
    await expect(
      withUserContext(userId, (c) =>
        c.query(`DELETE FROM public.association_distribution_allocations WHERE distribution_id = $1`, [distributionId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('association distributions: guards', () => {
  it('refuses to book unless the allocations equal the total, then freezes them', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const distributionId = await insertDistribution(companyId, userId, fiscalPeriodId, 1000)
    const anna = await insertMember(companyId, userId, '1')
    const bertil = await insertMember(companyId, userId, '2')
    await insertAllocation(companyId, userId, distributionId, anna, 600)

    // 600 allocated of 1 000: the status change is refused.
    const entryId = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      description: 'Utdelning på insatser: beslut',
      lines: [
        { accountNumber: '2091', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2898', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    await expect(
      getPool().query(
        `UPDATE public.association_distributions SET status = 'booked', journal_entry_id = $2 WHERE id = $1`,
        [distributionId, entryId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await insertAllocation(companyId, userId, distributionId, bertil, 400)
    await getPool().query(
      `UPDATE public.association_distributions SET status = 'booked', journal_entry_id = $2 WHERE id = $1`,
      [distributionId, entryId],
    )
    // Frozen: neither the total nor the allocations may change, and the row
    // cannot go back to decided.
    await expect(
      getPool().query(`UPDATE public.association_distributions SET total_amount = 900 WHERE id = $1`, [distributionId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.association_distributions SET status = 'decided' WHERE id = $1`, [distributionId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.association_distribution_allocations SET amount = 500 WHERE distribution_id = $1 AND member_id = $2`,
        [distributionId, anna],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insertAllocation(companyId, userId, distributionId, anna, 1)).rejects.toMatchObject({ code: '23514' })
  })

  it('ties the status to its verifikat links and refuses a non-positive total', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(insertDistribution(companyId, userId, fiscalPeriodId, 0)).rejects.toMatchObject({ code: '23514' })
    const distributionId = await insertDistribution(companyId, userId, fiscalPeriodId, 100)
    const memberId = await insertMember(companyId, userId, '1')
    await insertAllocation(companyId, userId, distributionId, memberId, 100)
    // booked without a decision verifikat: CHECK refuses.
    await expect(
      getPool().query(`UPDATE public.association_distributions SET status = 'booked' WHERE id = $1`, [distributionId]),
    ).rejects.toMatchObject({ code: '23514' })
    // An allocation for a member of another company is refused by the guard.
    const other = await seedCompany()
    const foreignMember = await insertMember(other.companyId, other.userId, '9')
    await expect(insertAllocation(other.companyId, other.userId, distributionId, foreignMember, 1)).rejects.toMatchObject({
      code: '23514',
    })
  })
})
