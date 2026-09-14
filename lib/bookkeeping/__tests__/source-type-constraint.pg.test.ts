import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { JournalEntrySourceTypeSchema } from '@/lib/api/schemas'
import { getPool } from '@/tests/pg/setup'
import { insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'

// Guards against drift between the TS/Zod source_type allowlist and the DB
// CHECK constraint `journal_entries_source_type_check`. Originally added
// after a production incident where 'inbox_item' was in the TS type and
// Zod schema but missing from the DB constraint, causing every standalone
// "Bokför direkt" from the document inbox to fail with PG 23514.
describe('journal_entries.source_type CHECK constraint', () => {
  it.each(JournalEntrySourceTypeSchema.options)(
    'accepts source_type=%s',
    async (sourceType) => {
      const { userId, companyId, fiscalPeriodId } = await seedCompany()

      await expect(
        insertDraftJournalEntry({ userId, companyId, fiscalPeriodId,
          description: `src=${sourceType}`, sourceType }),
      ).resolves.toBeDefined()
    },
  )

  it('rejects an unknown source_type value', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number,
            voucher_series, entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'bogus', 'not_a_real_source', 'draft')`,
        [randomUUID(), userId, companyId, fiscalPeriodId],
      ),
    ).rejects.toThrow(/source_type_check/i)
  })
})
