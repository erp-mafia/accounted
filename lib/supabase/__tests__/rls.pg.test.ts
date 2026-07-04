import { describe, expect, it } from 'vitest'
import { insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { withUserContext } from '@/tests/pg/setup'

describe('rls.pg: tenant isolation on journal_entries', () => {
  it('returns only the authenticated user\'s company rows', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    // One entry in each tenant.
    const entryA = await insertDraftJournalEntry({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
    })
    await insertDraftJournalEntry({
      userId: b.userId,
      companyId: b.companyId,
      fiscalPeriodId: b.fiscalPeriodId,
    })

    // user A should see exactly entryA and nothing from tenant B.
    const rows = await withUserContext(a.userId, async (client) => {
      const res = await client.query<{ id: string; company_id: string }>(
        `SELECT id, company_id FROM public.journal_entries`,
      )
      return res.rows
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(entryA)
    expect(rows[0]!.company_id).toBe(a.companyId)
  })
})
