import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany, insertCashAccount, insertTransaction, insertPostedJournalEntry } from './fixtures'

// pg-real coverage for 20260824190000_gl_lines_consider_voucher_links: a
// verifikat anchored to a transaction only through transaction_voucher_links
// (bulk-book samlingsverifikat, residual bookings) must count as matched in
// both GL RPCs exactly like a pointer-linked one: absent from the unlinked
// list, absent from the default matching candidates, present with a
// linked_transaction_count of 1 when matched vouchers are included.

async function linkThroughJunction(params: {
  userId: string
  companyId: string
  transactionId: string
  journalEntryId: string
  amount: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6, 'other')`,
    [randomUUID(), params.userId, params.companyId, params.transactionId, params.journalEntryId, params.amount],
  )
}

describe('GL line RPCs treat transaction_voucher_links as links', () => {
  it('hides a junction-linked verifikat from the unlinked list and the default candidates', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1930' })

    // Control: an unlinked verifikat on 1930 keeps surfacing.
    const unlinkedEntry = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-06-10',
      description: 'Utan koppling',
      lines: [
        { accountNumber: '6570', debitAmount: 45, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 45 },
      ],
    })
    // Junction-linked: the transaction's pointer stays NULL.
    const junctionEntry = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-06-11',
      description: 'Bankavgift: restbelopp',
      lines: [
        { accountNumber: '6570', debitAmount: 10, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 10 },
      ],
    })
    const txId = await insertTransaction({
      companyId,
      userId,
      amount: -10,
      date: '2026-06-11',
      cashAccountId,
      journalEntryId: null,
    })
    await linkThroughJunction({ userId, companyId, transactionId: txId, journalEntryId: junctionEntry, amount: -10 })

    const unlinked = await getPool().query<{ journal_entry_id: string }>(
      `SELECT journal_entry_id FROM public.get_unlinked_gl_lines($1, '1930', NULL, NULL)`,
      [companyId],
    )
    const unlinkedIds = unlinked.rows.map((r) => r.journal_entry_id)
    expect(unlinkedIds).toContain(unlinkedEntry)
    expect(unlinkedIds).not.toContain(junctionEntry)

    const candidates = await getPool().query<{ journal_entry_id: string; linked_transaction_count: number }>(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching($1, '1930', NULL, NULL, false)`,
      [companyId],
    )
    const candidateIds = candidates.rows.map((r) => r.journal_entry_id)
    expect(candidateIds).toContain(unlinkedEntry)
    expect(candidateIds).not.toContain(junctionEntry)

    const withMatched = await getPool().query<{ journal_entry_id: string; linked_transaction_count: number }>(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching($1, '1930', NULL, NULL, true)`,
      [companyId],
    )
    const junctionRow = withMatched.rows.find((r) => r.journal_entry_id === junctionEntry)
    expect(junctionRow?.linked_transaction_count).toBe(1)
    const controlRow = withMatched.rows.find((r) => r.journal_entry_id === unlinkedEntry)
    expect(controlRow?.linked_transaction_count).toBe(0)
  })

  it('does not double count a transaction that is both pointer- and junction-linked to the same verifikat', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    const entry = await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      entryDate: '2026-06-12',
      lines: [
        { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const txId = await insertTransaction({ companyId, userId, amount: 1000, date: '2026-06-12', cashAccountId, journalEntryId: entry })
    await linkThroughJunction({ userId, companyId, transactionId: txId, journalEntryId: entry, amount: 1000 })

    const withMatched = await getPool().query<{ journal_entry_id: string; linked_transaction_count: number }>(
      `SELECT journal_entry_id, linked_transaction_count
         FROM public.get_account_gl_lines_for_matching($1, '1930', NULL, NULL, true)`,
      [companyId],
    )
    expect(withMatched.rows.find((r) => r.journal_entry_id === entry)?.linked_transaction_count).toBe(1)
  })
})
