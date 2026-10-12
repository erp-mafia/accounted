import { describe, expect, it } from 'vitest'
import { invoiceReferenceKeys } from '@/lib/invoices/ocr-keys'
import {
  bankCheckOutcome,
  bankCheckSnapshot,
  bankFreshness,
  classifyBankCandidates,
  runBankCheck,
  type BankCandidateRow,
  type BankCheckPayeeAccount,
} from '../bank-check'
import { CASH_ACCOUNT_ID, COMPANY_ID, createMemorySupabase } from './memory-supabase'

const INVOICE = { id: 'inv-1', invoice_number: '20261042' }
const OCR = invoiceReferenceKeys(INVOICE.invoice_number).find((k) => k.form === 'ocr')!.key

function row(overrides: Partial<BankCandidateRow>): BankCandidateRow {
  return {
    id: 'tx-1',
    date: '2026-09-15',
    amount: 500,
    description: 'Insättning',
    original_description: null,
    merchant_name: null,
    reference: null,
    potential_invoice_id: null,
    ...overrides,
  }
}

const classify = (rows: BankCandidateRow[], dismissed: string[] = [], remaining = 1250) =>
  classifyBankCandidates(rows, { invoice: INVOICE, customerName: 'Kundbolaget Norr AB', remaining, dismissedTransactionIds: dismissed })

describe('classifyBankCandidates', () => {
  it('finds the printed OCR in the reference, whatever the amount', () => {
    expect(classify([row({ reference: OCR, amount: 99999 })])).toMatchObject([{ transactionId: 'tx-1', reason: 'reference', dismissed: false }])
  })

  it('finds the invoice number in the free text', () => {
    expect(classify([row({ description: 'Betalning faktura 20261042' })])).toMatchObject([{ reason: 'reference' }])
  })

  it('finds the customer name with an amount up to what is left (partial payments count)', () => {
    expect(classify([row({ description: 'KUNDBOLAGET NORR', amount: 300 })])).toMatchObject([{ reason: 'name' }])
    expect(classify([row({ description: 'KUNDBOLAGET NORR', amount: 1251 })])).toMatchObject([{ reason: 'name' }])
    expect(classify([row({ description: 'KUNDBOLAGET NORR', amount: 1251.01 })])).toEqual([])
  })

  it('takes the matcher hint for this invoice', () => {
    expect(classify([row({ potential_invoice_id: 'inv-1' })])).toMatchObject([{ reason: 'hint' }])
  })

  it('ignores outgoing rows and unrelated payments', () => {
    expect(classify([row({ amount: -500, reference: OCR }), row({ id: 'tx-2', description: 'Lön' })])).toEqual([])
  })

  it('lists a dismissed candidate without letting it block', () => {
    const candidates = classify([row({ reference: OCR })], ['tx-1'])
    expect(candidates).toMatchObject([{ dismissed: true }])
    expect(bankCheckOutcome('fresh', candidates)).toBe('pass')
  })
})

describe('bankFreshness and bankCheckOutcome', () => {
  const account = (fresh: boolean, connected = true): BankCheckPayeeAccount => ({
    cashAccountId: 'ca',
    name: 'Företagskonto',
    ledgerAccount: '1930',
    bankConnectionId: connected ? 'bc' : null,
    syncedAt: '2026-10-06T08:00:00Z',
    fresh,
  })

  it('answers no_bank without a connected payee account, stale when one is not fresh', () => {
    expect(bankFreshness([])).toBe('no_bank')
    expect(bankFreshness([account(true, false)])).toBe('no_bank')
    expect(bankFreshness([account(false)])).toBe('stale')
    expect(bankFreshness([account(true)])).toBe('fresh')
  })

  it('puts candidates before freshness', () => {
    const blocking = classify([row({ reference: OCR })])
    expect(bankCheckOutcome('stale', blocking)).toBe('candidates')
    expect(bankCheckOutcome('stale', [])).toBe('stale')
    expect(bankCheckOutcome('no_bank', [])).toBe('no_bank')
  })
})

describe('runBankCheck', () => {
  const NOW = new Date('2026-10-06T10:00:00Z')

  function seed(lastSyncedAt: string | null, status = 'active') {
    const db = createMemorySupabase()
    db.seed('invoice_payee_defaults', [{ company_id: COMPANY_ID, currency: 'SEK', cash_account_id: CASH_ACCOUNT_ID }])
    db.seed('cash_accounts', [{ id: CASH_ACCOUNT_ID, company_id: COMPANY_ID, name: 'Företagskonto', ledger_account: '1930', bank_connection_id: 'bc-1' }])
    db.seed('bank_connections', [{ id: 'bc-1', company_id: COMPANY_ID, status, last_synced_at: lastSyncedAt }])
    return db
  }

  const tx = (overrides: Record<string, unknown>) => ({
    company_id: COMPANY_ID,
    date: '2026-09-15',
    amount: 1250,
    description: 'Insättning',
    original_description: null,
    merchant_name: null,
    reference: null,
    potential_invoice_id: null,
    is_ignored: false,
    invoice_id: null,
    supplier_invoice_id: null,
    journal_entry_id: null,
    is_business: null,
    ...overrides,
  })

  const input = {
    companyId: COMPANY_ID,
    invoice: { id: 'inv-1', invoice_number: '20261042', invoice_date: '2026-08-01', currency: 'SEK', payment_cash_account_id: null },
    customerName: 'Kundbolaget Norr AB',
    remaining: 1250,
    dismissedTransactionIds: [],
    today: '2026-10-06',
    now: NOW,
  }

  it('passes with a fresh payee account and no unexplained payment', async () => {
    const db = seed('2026-10-06T02:00:00Z')
    const result = await runBankCheck(db.client, input)
    expect(result).toMatchObject({ outcome: 'pass', freshness: 'fresh', lastSyncedAt: '2026-10-06T02:00:00Z', candidates: [] })
    expect(result.payeeAccounts).toMatchObject([{ cashAccountId: CASH_ACCOUNT_ID, ledgerAccount: '1930', fresh: true }])
  })

  it('is stale when the account the customer pays to was not synced in 24 hours, or its connection is not active', async () => {
    expect((await runBankCheck(seed('2026-10-05T09:59:00Z').client, input)).outcome).toBe('stale')
    expect((await runBankCheck(seed('2026-10-06T02:00:00Z', 'expired').client, input)).outcome).toBe('stale')
    expect((await runBankCheck(seed(null).client, input)).outcome).toBe('stale')
  })

  it('reads the invoice own payee account before the currency default', async () => {
    const db = seed('2026-10-06T02:00:00Z')
    db.seed('cash_accounts', [{ id: 'other', company_id: COMPANY_ID, name: 'Sparkonto', ledger_account: '1940', bank_connection_id: null }])
    const result = await runBankCheck(db.client, { ...input, invoice: { ...input.invoice, payment_cash_account_id: 'other' } })
    expect(result.outcome).toBe('no_bank')
    expect(result.payeeAccounts).toMatchObject([{ ledgerAccount: '1940', bankConnectionId: null }])
  })

  it('reads inbound, unexplained rows from the invoice date, unclassified rows included', async () => {
    const db = seed('2026-10-06T02:00:00Z')
    db.seed('transactions', [
      tx({ id: 'hit', reference: OCR }),
      tx({ id: 'unclassified', description: 'KUNDBOLAGET NORR', is_business: null, amount: 400 }),
      tx({ id: 'private', reference: OCR, is_business: false }),
      tx({ id: 'before', reference: OCR, date: '2026-07-31' }),
      tx({ id: 'ignored', reference: OCR, is_ignored: true }),
      tx({ id: 'linked', reference: OCR, invoice_id: 'inv-9' }),
      tx({ id: 'booked', reference: OCR, journal_entry_id: 'je-1' }),
      tx({ id: 'allocated', reference: OCR }),
    ])
    db.seed('invoice_payments', [{ id: 'p-1', company_id: COMPANY_ID, invoice_id: 'inv-9', transaction_id: 'allocated' }])
    const result = await runBankCheck(db.client, input)
    expect(result.outcome).toBe('candidates')
    expect(result.candidates.map((c) => c.transactionId).sort()).toEqual(['hit', 'unclassified'])
  })

  it('reads every unexplained row, so an early payment behind a long unbooked backlog is still found', async () => {
    const db = seed('2026-10-06T02:00:00Z')
    // 1 200 later, unrelated deposits nobody has booked, and the customer's
    // payment on the due date: the oldest row of them all.
    const backlog = Array.from({ length: 1200 }, (_, i) =>
      tx({ id: `backlog-${String(i).padStart(4, '0')}`, date: '2026-10-01', description: 'Swish', amount: 99 }),
    )
    db.seed('transactions', [...backlog, tx({ id: 'early-payment', date: '2026-08-31', reference: OCR })])
    const result = await runBankCheck(db.client, input)
    expect(result.outcome).toBe('candidates')
    expect(result.candidates.map((c) => c.transactionId)).toEqual(['early-payment'])
  })

  it('stores a snapshot with the attestation and the dismissals', async () => {
    const db = seed('2026-10-05T01:00:00Z')
    db.seed('transactions', [tx({ id: 'hit', reference: OCR })])
    const result = await runBankCheck(db.client, { ...input, dismissedTransactionIds: ['hit'] })
    expect(result.outcome).toBe('stale')
    const snapshot = bankCheckSnapshot(result, {
      actorUserId: 'user-1',
      bankAttested: true,
      deliveredOutcome: 'delivered',
      importedAttestation: false,
      responseAttestation: false,
    })
    expect(snapshot).toMatchObject({
      outcome: 'stale',
      candidate_transaction_ids: ['hit'],
      dismissed: [{ transaction_id: 'hit', by: 'user-1' }],
      attested_by: 'user-1',
      payee_accounts: [{ cash_account_id: CASH_ACCOUNT_ID, synced_at: '2026-10-05T01:00:00Z' }],
    })
  })
})
