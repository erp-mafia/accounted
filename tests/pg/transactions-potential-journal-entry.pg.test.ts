import { describe, expect, it } from 'vitest'
import { seedCompany, insertTransaction, insertDraftJournalEntry } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for persisted journal-entry match suggestions
 * (20260813121000_transactions_potential_journal_entry.sql).
 *
 * Locks in:
 *   - the all-or-nothing CHECK on the suggestion trio,
 *   - self-clear on link / ignore (BEFORE trigger),
 *   - sibling-clear when the suggested verifikat is consumed by another
 *     transaction's link (the double-consume guard bulk confirm relies on),
 *   - clear on storno reversal of the suggested entry,
 *   - the sweep-summary JSONB columns.
 */

// status: 'posted' routes to insertPostedJournalEntry, which inserts a default
// balanced 1930/3001 line pair in the same transaction: adding lines afterwards
// would trip the line-immutability trigger.
async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<string> {
  return insertDraftJournalEntry({ ...params, status: 'posted' })
}

async function setSuggestion(txId: string, jeId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.transactions
     SET potential_journal_entry_id = $2,
         potential_match_method = 'auto_date_range',
         potential_match_confidence = 0.85
     WHERE id = $1`,
    [txId, jeId],
  )
}

async function getSuggestion(txId: string): Promise<{
  potential_journal_entry_id: string | null
  potential_match_method: string | null
  potential_match_confidence: string | null
}> {
  const { rows } = await getPool().query(
    `SELECT potential_journal_entry_id, potential_match_method, potential_match_confidence
     FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return rows[0]
}

describe('transactions potential_journal_entry: schema', () => {
  it('accepts a full suggestion trio on an unlinked transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const jeId = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txId = await insertTransaction({ companyId, userId })

    await setSuggestion(txId, jeId)

    const row = await getSuggestion(txId)
    expect(row.potential_journal_entry_id).toBe(jeId)
    expect(row.potential_match_method).toBe('auto_date_range')
    expect(Number(row.potential_match_confidence)).toBe(0.85)
  })

  it('rejects a partial trio (id without method/confidence)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const jeId = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txId = await insertTransaction({ companyId, userId })

    await expect(
      getPool().query(
        `UPDATE public.transactions SET potential_journal_entry_id = $2 WHERE id = $1`,
        [txId, jeId],
      ),
    ).rejects.toThrow(/transactions_potential_je_check/)
  })
})

describe('transactions potential_journal_entry: self-clear trigger', () => {
  it('clears the suggestion when the transaction is linked to any journal entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const suggestedJe = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const otherJe = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txId = await insertTransaction({ companyId, userId })
    await setSuggestion(txId, suggestedJe)

    // Link the row elsewhere (any path setting journal_entry_id qualifies).
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`,
      [txId, otherJe],
    )

    const row = await getSuggestion(txId)
    expect(row.potential_journal_entry_id).toBeNull()
    expect(row.potential_match_method).toBeNull()
    expect(row.potential_match_confidence).toBeNull()
  })

  it('clears the suggestion when the transaction is ignored', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const jeId = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txId = await insertTransaction({ companyId, userId })
    await setSuggestion(txId, jeId)

    await getPool().query(`UPDATE public.transactions SET is_ignored = true WHERE id = $1`, [txId])

    const row = await getSuggestion(txId)
    expect(row.potential_journal_entry_id).toBeNull()
  })
})

describe('transactions potential_journal_entry: sibling-clear on consumption', () => {
  it('clears other rows suggesting a verifikat once any transaction links to it', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const jeId = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txA = await insertTransaction({ companyId, userId, externalId: 'ext-a' })
    const txB = await insertTransaction({ companyId, userId, externalId: 'ext-b' })
    await setSuggestion(txA, jeId)
    await setSuggestion(txB, jeId)

    // txA consumes the verifikat.
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`,
      [txA, jeId],
    )

    // txB's suggestion is gone: bulk confirm can no longer double-consume.
    const rowB = await getSuggestion(txB)
    expect(rowB.potential_journal_entry_id).toBeNull()
    expect(rowB.potential_match_method).toBeNull()
  })

  it('does not clear suggestions pointing at OTHER verifikat', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const je1 = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const je2 = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txA = await insertTransaction({ companyId, userId, externalId: 'ext-a2' })
    const txB = await insertTransaction({ companyId, userId, externalId: 'ext-b2' })
    await setSuggestion(txA, je1)
    await setSuggestion(txB, je2)

    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2 WHERE id = $1`,
      [txA, je1],
    )

    const rowB = await getSuggestion(txB)
    expect(rowB.potential_journal_entry_id).toBe(je2)
  })
})

describe('transactions potential_journal_entry: clear on reversal', () => {
  it('clears suggestions pointing at an entry that is reversed via storno', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const jeId = await insertPostedEntry({ userId, companyId, fiscalPeriodId })
    const txId = await insertTransaction({ companyId, userId })
    await setSuggestion(txId, jeId)

    // The storno path's status transition (posted -> reversed).
    await getPool().query(
      `UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`,
      [jeId],
    )

    const row = await getSuggestion(txId)
    expect(row.potential_journal_entry_id).toBeNull()
  })
})

describe('sweep summary columns', () => {
  it('bank_file_imports.sie_sweep and bank_connections.last_sie_sweep exist as JSONB', async () => {
    const { rows } = await getPool().query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE (table_name = 'bank_file_imports' AND column_name = 'sie_sweep')
          OR (table_name = 'bank_connections' AND column_name = 'last_sie_sweep')`,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.data_type).toBe('jsonb')
    }
  })
})
