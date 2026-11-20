import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertCashAccount, insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'

// pg-real coverage for 20261006121002_gl_lines_partially_allocated_remaining:
// a verifikat that 1:N bank_line slices settle only in part stays among the
// unmatched ledger lines of both GL RPCs, carrying remaining_amount (its net
// on the account minus the slices); a fully allocated one drops out as
// before, and junction shapes the rule does not cover keep the old behaviour
// (agent feedback seq 854089).

type Owner = Awaited<ReturnType<typeof seedCompany>>

async function slice(owner: Owner, transactionId: string, journalEntryId: string, amount: number, role = 'bank_line') {
  await getPool().query(
    `INSERT INTO public.transaction_voucher_links
       (company_id, user_id, transaction_id, journal_entry_id, allocated_amount, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [owner.companyId, owner.userId, transactionId, journalEntryId, amount, role],
  )
}

function bankOut(owner: Owner, amount: number, description: string, lines?: Parameters<typeof insertPostedJournalEntry>[0]['lines']) {
  return insertPostedJournalEntry({
    ...owner,
    entryDate: '2026-06-01',
    description,
    lines: lines ?? [
      { accountNumber: '2440', debitAmount: amount, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: amount },
    ],
  })
}

async function unlinked(companyId: string) {
  const { rows } = await getPool().query<{ journal_entry_id: string; remaining_amount: string | null }>(
    `SELECT journal_entry_id, remaining_amount FROM public.get_unlinked_gl_lines($1, '1930', NULL, NULL)`,
    [companyId],
  )
  return new Map(rows.map((r) => [r.journal_entry_id, r.remaining_amount === null ? null : Number(r.remaining_amount)]))
}

async function candidates(companyId: string, includeMatched: boolean) {
  const { rows } = await getPool().query<{ journal_entry_id: string; remaining_amount: string | null }>(
    `SELECT journal_entry_id, remaining_amount
       FROM public.get_account_gl_lines_for_matching($1, '1930', NULL, NULL, $2)`,
    [companyId, includeMatched],
  )
  return new Map(rows.map((r) => [r.journal_entry_id, r.remaining_amount === null ? null : Number(r.remaining_amount)]))
}

describe('GL line RPCs keep a partially allocated verifikat with its remainder', () => {
  it('lists the -200 left of a -300 verifikat a -100 slice settles, and drops the fully sliced one', async () => {
    const owner = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930' })
    const partial = await bankOut(owner, 300, 'Delvis kopplad')
    const full = await bankOut(owner, 400, 'Helt kopplad')
    const untouched = await bankOut(owner, 45, 'Utan koppling')
    const txId = await insertTransaction({
      companyId: owner.companyId,
      userId: owner.userId,
      amount: -500,
      date: '2026-06-01',
      cashAccountId,
    })
    await slice(owner, txId, partial, -100)
    await slice(owner, txId, full, -400)

    const rows = await unlinked(owner.companyId)
    expect(rows.get(partial)).toBe(-200)
    expect(rows.has(full)).toBe(false)
    // A verifikat with no junction row: its lines are the open amount.
    expect(rows.has(untouched)).toBe(true)
    expect(rows.get(untouched)).toBeNull()

    const open = await candidates(owner.companyId, false)
    expect(open.get(partial)).toBe(-200)
    expect(open.has(full)).toBe(false)
    expect(open.get(untouched)).toBeNull()

    // With matched vouchers included, the fully sliced one reports nothing left.
    const all = await candidates(owner.companyId, true)
    expect(all.get(full)).toBe(0)
    expect(all.get(partial)).toBe(-200)
  })

  it('keeps a residual or clearing junction row meaning "settled", as before', async () => {
    const owner = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930' })
    const residual = await bankOut(owner, 50, 'Restbelopp')
    const txId = await insertTransaction({
      companyId: owner.companyId,
      userId: owner.userId,
      amount: -10,
      date: '2026-06-01',
      cashAccountId,
    })
    await slice(owner, txId, residual, -10, 'other')

    expect((await unlinked(owner.companyId)).has(residual)).toBe(false)
    expect((await candidates(owner.companyId, false)).has(residual)).toBe(false)
  })

  it('does not net a slice on another cash account against this account (the other leg of a transfer)', async () => {
    const owner = await seedCompany()
    await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930' })
    const savingsId = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1931' })
    // 70 moved from 1930 to 1931; only the 1931 side is linked, as a slice.
    const transfer = await bankOut(owner, 70, 'Överföring', [
      { accountNumber: '1931', debitAmount: 70, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 70 },
    ])
    const txId = await insertTransaction({
      companyId: owner.companyId,
      userId: owner.userId,
      amount: 70,
      date: '2026-06-01',
      cashAccountId: savingsId,
    })
    await slice(owner, txId, transfer, 70)

    // get_unlinked_gl_lines keeps treating any junction row as settled here.
    expect((await unlinked(owner.companyId)).has(transfer)).toBe(false)
    // The account-scoped candidates surface the unsettled 1930 leg, as before
    // (#1026), with no remainder computed from another account's slice.
    const open = await candidates(owner.companyId, false)
    expect(open.has(transfer)).toBe(true)
    expect(open.get(transfer)).toBeNull()
  })

  it('treats a pointer link as fully settled even beside a partial slice', async () => {
    const owner = await seedCompany()
    const cashAccountId = await insertCashAccount({ companyId: owner.companyId, ledgerAccount: '1930' })
    const entry = await bankOut(owner, 300, 'Två betalningar')
    const first = await insertTransaction({
      companyId: owner.companyId,
      userId: owner.userId,
      amount: -100,
      date: '2026-06-01',
      cashAccountId,
    })
    await slice(owner, first, entry, -100)
    await insertTransaction({
      companyId: owner.companyId,
      userId: owner.userId,
      amount: -200,
      date: '2026-06-02',
      cashAccountId,
      journalEntryId: entry,
    })

    expect((await unlinked(owner.companyId)).has(entry)).toBe(false)
    expect((await candidates(owner.companyId, false)).has(entry)).toBe(false)
  })
})
