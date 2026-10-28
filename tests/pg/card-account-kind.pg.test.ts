/**
 * pg-real test for company cards as cash accounts (migration
 * 20261028090000_cash_accounts_card_kind).
 *
 *   - the shape CHECKs: a card books on 2480-2489 / 2890 / 2894 / 2896 / 2899
 *     only (2893 refused), is never a payee or the primary and carries no
 *     IBAN or bank connection; a bank row never books on a 2xxx account;
 *   - the NULL-row fallback counts banks only: a company with one 1940 bank
 *     account and a card books an unbound row on 1940, in
 *     bank_anchor_settlement_account, capture_bank_booking_context and
 *     guard_bank_booking_context alike;
 *   - a card purchase D 6540 / K 2890 passes guard_bank_booking_context, the
 *     wrong side is refused, and the card's payment D 2890 / K 1930 passes;
 *   - get_ledger_usage_stats and get_ledger_deep_context leave the card
 *     ledger out of a counterparty's dominant account.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertCashAccount, insertPostedBankJournalEntry, insertTransaction, seedCompany } from './fixtures'

async function insertCard(params: {
  companyId: string
  ledgerAccount?: string
  currency?: string
  invoicePayee?: boolean
  isPrimary?: boolean
  iban?: string | null
  source?: string
  cardIssuer?: string | null
  cardLast4?: string[] | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.cash_accounts
       (id, company_id, ledger_account, currency, name, kind, card_issuer, card_last4,
        invoice_payee, is_primary, iban, source)
     VALUES ($1, $2, $3, $4, 'Företagskort', 'card', $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.companyId,
      params.ledgerAccount ?? '2890',
      params.currency ?? 'SEK',
      params.cardIssuer === undefined ? 'eurocard' : params.cardIssuer,
      params.cardLast4 === undefined ? ['3667'] : params.cardLast4,
      params.invoicePayee ?? false,
      params.isPrimary ?? false,
      params.iban ?? null,
      params.source ?? 'manual',
    ],
  )
  return id
}

async function bindMerchant(transactionId: string, merchantName: string, entryId: string): Promise<void> {
  await getPool().query(
    'UPDATE public.transactions SET merchant_name = $2, journal_entry_id = $3 WHERE id = $1',
    [transactionId, merchantName, entryId],
  )
}

describe('cash_accounts card shape', () => {
  it('accepts a card on each allowed liability ledger', async () => {
    const { companyId } = await seedCompany()
    for (const ledger of ['2480', '2489', '2890', '2894', '2896', '2899']) {
      await expect(insertCard({ companyId, ledgerAccount: ledger })).resolves.toBeTruthy()
    }
  })

  it.each(['2893', '2891', '2440', '1930', '6540'])('refuses a card on %s', async (ledger) => {
    const { companyId } = await seedCompany()
    await expect(insertCard({ companyId, ledgerAccount: ledger })).rejects.toMatchObject({
      code: '23514',
      constraint: 'cash_accounts_card_shape',
    })
  })

  it('refuses a card that is a customer payee', async () => {
    const { companyId } = await seedCompany()
    // The payee trigger (cash_accounts_payee_admin_only) or the shape CHECK:
    // either way the row never exists.
    await expect(insertCard({ companyId, invoicePayee: true })).rejects.toThrow()
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM cash_accounts WHERE company_id = $1', [companyId])
    expect(rows[0].n).toBe(0)
  })

  it('refuses a card that is the primary account', async () => {
    const { companyId } = await seedCompany()
    await expect(insertCard({ companyId, isPrimary: true })).rejects.toMatchObject({
      code: '23514',
      constraint: 'cash_accounts_card_shape',
    })
  })

  it('refuses a card with an IBAN or from a bank feed', async () => {
    const { companyId } = await seedCompany()
    await expect(insertCard({ companyId, iban: 'SE4550000000058398257466' })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_shape',
    })
    await expect(insertCard({ companyId, ledgerAccount: '2899', source: 'enable_banking' })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_shape',
    })
  })

  it('refuses card fields and 2xxx ledgers on a bank row', async () => {
    const { companyId } = await seedCompany()
    await expect(insertCashAccount({ companyId, ledgerAccount: '2890' })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_shape',
    })
    const bankId = await insertCashAccount({ companyId, ledgerAccount: '1930' })
    await expect(
      getPool().query("UPDATE cash_accounts SET card_issuer = 'amex' WHERE id = $1", [bankId]),
    ).rejects.toMatchObject({ constraint: 'cash_accounts_card_shape' })
    const { rows } = await getPool().query('SELECT kind FROM cash_accounts WHERE id = $1', [bankId])
    expect(rows[0].kind).toBe('bank')
  })

  it('checks the last four digits and the issuer shape', async () => {
    const { companyId } = await seedCompany()
    await expect(insertCard({ companyId, cardLast4: ['366'] })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_last4_shape',
    })
    await expect(insertCard({ companyId, cardLast4: ['3667', 'abcd'] })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_last4_shape',
    })
    await expect(insertCard({ companyId, cardLast4: [] })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_last4_shape',
    })
    await expect(insertCard({ companyId, cardIssuer: 'Eurocard Företag' })).rejects.toMatchObject({
      constraint: 'cash_accounts_card_issuer_shape',
    })
    await expect(insertCard({ companyId, cardLast4: ['3667', '1234'], cardIssuer: null })).resolves.toBeTruthy()
  })

  it('keeps one card per ledger', async () => {
    const { companyId } = await seedCompany()
    await insertCard({ companyId, ledgerAccount: '2890' })
    await expect(insertCard({ companyId, ledgerAccount: '2890' })).rejects.toMatchObject({ code: '23505' })
  })
})

describe('the unbound-row fallback ignores cards', () => {
  it('books a NULL row on the only bank account, not 1930, once a card exists', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1940' })
    await insertCard({ companyId, ledgerAccount: '2890' })
    const txId = await insertTransaction({ companyId, userId, amount: -200, cashAccountId: null })

    const anchor = await getPool().query(
      "SELECT public.bank_anchor_settlement_account($1, NULL, 'SEK') AS ledger",
      [companyId],
    )
    expect(anchor.rows[0].ledger).toBe('1940')

    const captured = await getPool().query(
      'SELECT public.capture_bank_booking_context($1, ARRAY[$2]::uuid[]) AS context',
      [companyId, txId],
    )
    expect(captured.rows[0].context[0].settlement_account).toBe('1940')

    // guard_bank_booking_context recomputes the same ledger at posting.
    const entryId = await insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: txId,
      lines: [
        { accountNumber: '6540', debitAmount: 200, creditAmount: 0 },
        { accountNumber: '1940', debitAmount: 0, creditAmount: 200 },
      ],
    })
    expect(entryId).toBeTruthy()
  })

  it('still falls back to 1930 with two bank accounts in the currency', async () => {
    const { companyId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1940' })
    await insertCashAccount({ companyId, ledgerAccount: '1941' })
    await insertCard({ companyId, ledgerAccount: '2899' })
    const anchor = await getPool().query(
      "SELECT public.bank_anchor_settlement_account($1, NULL, 'SEK') AS ledger",
      [companyId],
    )
    expect(anchor.rows[0].ledger).toBe('1930')
  })

  it('never answers a card ledger for a NULL row, even when the card is the only account', async () => {
    const { companyId } = await seedCompany()
    await insertCard({ companyId, ledgerAccount: '2890' })
    const anchor = await getPool().query(
      "SELECT public.bank_anchor_settlement_account($1, NULL, 'SEK') AS ledger",
      [companyId],
    )
    expect(anchor.rows[0].ledger).toBe('1930')
  })
})

describe('booking a card row', () => {
  it('posts a purchase D 6540 / K 2890 and refuses it on the wrong side', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const cardId = await insertCard({ companyId, ledgerAccount: '2890' })
    const purchase = await insertTransaction({ companyId, userId, amount: -349, cashAccountId: cardId })

    await expect(insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: purchase,
      lines: [
        { accountNumber: '2890', debitAmount: 349, creditAmount: 0 },
        { accountNumber: '6540', debitAmount: 0, creditAmount: 349 },
      ],
    })).rejects.toThrow(/BANK_BOOKING_SETTLEMENT_CHANGED/)

    await expect(insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: purchase,
      lines: [
        { accountNumber: '6540', debitAmount: 279.2, creditAmount: 0 },
        { accountNumber: '2641', debitAmount: 69.8, creditAmount: 0 },
        { accountNumber: '2890', debitAmount: 0, creditAmount: 349 },
      ],
    })).resolves.toBeTruthy()
  })

  it('refuses a card purchase booked on the bank instead of the card', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const cardId = await insertCard({ companyId, ledgerAccount: '2890' })
    const purchase = await insertTransaction({ companyId, userId, amount: -95, cashAccountId: cardId })
    await expect(insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: purchase,
      lines: [
        { accountNumber: '6570', debitAmount: 95, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 95 },
      ],
    })).rejects.toThrow(/BANK_BOOKING_SETTLEMENT_CHANGED/)
  })

  it('posts the card payment D 2890 / K 1930 from the card inflow', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const cardId = await insertCard({ companyId, ledgerAccount: '2890' })
    const payment = await insertTransaction({ companyId, userId, amount: 12345, cashAccountId: cardId })
    await expect(insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: payment,
      lines: [
        { accountNumber: '2890', debitAmount: 12345, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 12345 },
      ],
    })).resolves.toBeTruthy()
  })
})

describe('ledger statistics leave the card ledger out', () => {
  it('reports the cost account, not 2890, as a card merchant\'s dominant account', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const cardId = await insertCard({ companyId, ledgerAccount: '2890' })
    const purchase = await insertTransaction({
      companyId, userId, amount: -500, date: '2026-06-01', cashAccountId: cardId,
    })
    const entryId = await insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: purchase, entryDate: '2026-06-01',
      lines: [
        { accountNumber: '6540', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '2890', debitAmount: 0, creditAmount: 500 },
      ],
    })
    await bindMerchant(purchase, 'Kortbutiken Molnet', entryId)

    const stats = (await getPool().query(
      "SELECT public.get_ledger_usage_stats($1, '2026-01-01') AS s",
      [companyId],
    )).rows[0].s as { counterparty_patterns: Array<{ counterparty: string; dominant_account_number: string | null }> }
    const pattern = stats.counterparty_patterns.find((p) => p.counterparty === 'Kortbutiken Molnet')
    expect(pattern?.dominant_account_number).toBe('6540')

    const deep = (await getPool().query(
      'SELECT public.get_ledger_deep_context($1, NULL) AS d',
      [companyId],
    )).rows[0].d as { counterparty_entities: Array<{ name: string; dominant_account_number: string | null; dominant_account_total: number }> }
    const entity = deep.counterparty_entities.find((e) => e.name === 'Kortbutiken Molnet')
    expect(entity?.dominant_account_number).toBe('6540')
    expect(Number(entity?.dominant_account_total)).toBe(1)
  })

  it('still counts 2890 for a company that has no card on it', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
    const row = await insertTransaction({ companyId, userId, amount: -500, date: '2026-06-01' })
    const entryId = await insertPostedBankJournalEntry({
      userId, companyId, fiscalPeriodId, transactionId: row, entryDate: '2026-06-01',
      lines: [
        { accountNumber: '2890', debitAmount: 500, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 500 },
      ],
    })
    await bindMerchant(row, 'Skuldbolaget Norr', entryId)
    const stats = (await getPool().query(
      "SELECT public.get_ledger_usage_stats($1, '2026-01-01') AS s",
      [companyId],
    )).rows[0].s as { counterparty_patterns: Array<{ counterparty: string; dominant_account_number: string | null }> }
    expect(stats.counterparty_patterns.find((p) => p.counterparty === 'Skuldbolaget Norr')?.dominant_account_number)
      .toBe('2890')
  })
})
