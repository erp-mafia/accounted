import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assertCorrectionKeepsBankAccount } from '../correction-bank-leg'
import { CorrectionBankAccountChangedError } from '@/lib/bookkeeping/errors'

interface Row {
  id: string
  amount: number
  currency: string | null
  cash_account_id: string | null
}

interface Setup {
  pointer?: Row[]
  links?: Array<{ transaction_id: string; allocated_amount: number | null }>
  linked?: Row[]
  /** Settlement account per cash_account_id; 'error' makes the RPC fail. */
  ledgers?: Record<string, string> | 'error'
  cashLedgers?: string[]
}

function makeClient(setup: Setup) {
  const tablesRead: string[] = []
  const from = vi.fn((table: string) => {
    let filteredById = false
    const b: Record<string, unknown> = {}
    b.select = vi.fn(() => b)
    b.eq = vi.fn(() => b)
    b.in = vi.fn(() => {
      filteredById = true
      return b
    })
    b.then = (resolve: (v: unknown) => void) => {
      tablesRead.push(table)
      let data: unknown = []
      if (table === 'transactions') data = filteredById ? (setup.linked ?? []) : (setup.pointer ?? [])
      if (table === 'transaction_voucher_links') data = setup.links ?? []
      if (table === 'cash_accounts') data = (setup.cashLedgers ?? []).map((ledger_account) => ({ ledger_account }))
      resolve({ data, error: null })
    }
    return b
  })
  const rpc = vi.fn(async (_fn: string, args: { p_cash_account_id: string | null }) => {
    if (setup.ledgers === 'error') return { data: null, error: { message: 'BANK_ANCHOR_CASH_ACCOUNT_CHANGED' } }
    return { data: setup.ledgers?.[args.p_cash_account_id ?? ''] ?? '1930', error: null }
  })
  return { client: { from, rpc } as never, tablesRead, rpc }
}

const withdrawal: Row = { id: 'tx-1', amount: -1999, currency: 'SEK', cash_account_id: 'ca-1930' }

const original = [
  { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1999 },
]

describe('assertCorrectionKeepsBankAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses moving a withdrawal from the bank row\'s 1930 to 1931, naming both accounts', async () => {
    const { client } = makeClient({ pointer: [withdrawal], ledgers: { 'ca-1930': '1930' }, cashLedgers: ['1930', '1931'] })
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1931', debit_amount: 0, credit_amount: 1999 },
    ]

    const err = await assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved).catch((e) => e)

    expect(err).toBeInstanceOf(CorrectionBankAccountChangedError)
    expect(err.bankAccount).toBe('1930')
    expect(err.movedTo).toEqual(['1931'])
    expect(err.message).toContain('konto 1930')
    expect(err.message).toContain('till 1931')
    expect(err.message).toContain('makulera verifikationen')
  })

  it('refuses moving a deposit to a 19xx account with no cash account behind it', async () => {
    const deposit: Row = { id: 'tx-2', amount: 54.53, currency: 'SEK', cash_account_id: 'ca-1930' }
    const { client } = makeClient({ pointer: [deposit], ledgers: { 'ca-1930': '1930' }, cashLedgers: ['1930'] })
    const orig = [
      { account_number: '1930', debit_amount: 54.53, credit_amount: 0 },
      { account_number: '8311', debit_amount: 0, credit_amount: 54.53 },
    ]
    const moved = [
      { account_number: '1941', debit_amount: 54.53, credit_amount: 0 },
      { account_number: '8311', debit_amount: 0, credit_amount: 54.53 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', orig, moved)).rejects.toBeInstanceOf(
      CorrectionBankAccountChangedError,
    )
  })

  it('refuses moving the leg to a cash account ledger outside 19xx', async () => {
    const { client } = makeClient({ pointer: [withdrawal], ledgers: { 'ca-1930': '1930' }, cashLedgers: ['1930', '1630'] })
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1630', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved)).rejects.toBeInstanceOf(
      CorrectionBankAccountChangedError,
    )
  })

  it('refuses the move for a row anchored only through the junction (samlingsverifikat)', async () => {
    const { client } = makeClient({
      links: [{ transaction_id: 'tx-1', allocated_amount: -1999 }],
      linked: [withdrawal],
      ledgers: { 'ca-1930': '1930' },
      cashLedgers: ['1930', '1931'],
    })
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1931', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved)).rejects.toBeInstanceOf(
      CorrectionBankAccountChangedError,
    )
  })

  it('lets a correction take the bank leg out (a purchase rebooked as a supplier invoice, crm#1433)', async () => {
    const { client } = makeClient({ pointer: [withdrawal], ledgers: { 'ca-1930': '1930' }, cashLedgers: ['1930', '1931'] })
    const toSupplierInvoice = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '2440', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(
      assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, toSupplierInvoice),
    ).resolves.toBeUndefined()
  })

  it('lets a correction that keeps the bank leg through without reading the cash accounts', async () => {
    const { client, tablesRead } = makeClient({ pointer: [withdrawal], ledgers: { 'ca-1930': '1930' } })
    const recoded = [
      { account_number: '5410', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, recoded)).resolves.toBeUndefined()
    expect(tablesRead).not.toContain('cash_accounts')
  })

  it('does not judge a verifikat with no bank row', async () => {
    const { client, rpc } = makeClient({})
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1931', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved)).resolves.toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not judge an anchor whose original never booked the row\'s leg (from before the anchor guard)', async () => {
    const onOtherLedger: Row = { ...withdrawal, cash_account_id: 'ca-1931' }
    const { client } = makeClient({ pointer: [onOtherLedger], ledgers: { 'ca-1931': '1931' }, cashLedgers: ['1930', '1931'] })
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1932', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved)).resolves.toBeUndefined()
  })

  it('does not judge a row with no cash account (a CSV import): the bank names no account for it', async () => {
    const unbound: Row = { ...withdrawal, cash_account_id: null }
    const { client, rpc } = makeClient({ pointer: [unbound], cashLedgers: ['1930', '1931'] })
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1931', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved)).resolves.toBeUndefined()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not judge a row whose settlement account cannot be resolved', async () => {
    const { client } = makeClient({ pointer: [withdrawal], ledgers: 'error', cashLedgers: ['1930', '1931'] })
    const moved = [
      { account_number: '5420', debit_amount: 1999, credit_amount: 0 },
      { account_number: '1931', debit_amount: 0, credit_amount: 1999 },
    ]

    await expect(assertCorrectionKeepsBankAccount(client, 'co-1', 'orig-1', original, moved)).resolves.toBeUndefined()
  })
})
