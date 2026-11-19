/**
 * resolvePayingAccount: the one rule for which company account a payment
 * file pays from (crm#1483). The Supabase client answers per table, and
 * cash_accounts by what the chain asked: the primary (is_primary), the
 * enabled-SEK fallback listing, or every account of the company.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makePayingCashAccount, payingCashAccountsTable } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import {
  derivedBicWarningSv,
  payingAccountMissingSv,
  resolvePayingAccount,
  type PayingAccountSettings,
} from '../paying-account'

const COMPANY_ID = 'company-1'
const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

/** The account the books say 1930 is, connected to SEB: the bank reports its IBAN. */
const IBAN_1930 = 'SE4550000000058398257466'
/** The savings account, the IBAN SEK invoices print (and the settings mirror carries). */
const IBAN_1931 = 'SE7150000000058391234567'

type Row = ReturnType<typeof makePayingCashAccount>
const account = (overrides: Partial<Row> = {}) => makePayingCashAccount({ name: 'Företagskonto', ...overrides })

/** A client whose cash_accounts answer each of the resolver's three reads from `rows`. */
function client(rows: Row[]) {
  const mock = createTableMockSupabase({ cash_accounts: payingCashAccountsTable(rows) })
  return { ...mock, supabase: mock.supabase as unknown as SupabaseClient }
}

function resolve(rows: Row[], settings: PayingAccountSettings | null, bookedLedgerAccount?: string | null) {
  const { supabase, calls } = client(rows)
  return { calls, result: resolvePayingAccount(supabase, COMPANY_ID, log, { settings, bookedLedgerAccount }) }
}

describe('resolvePayingAccount', () => {
  it('pays from the primary, the account the salary is booked on, not the IBAN invoices print (crm#1483)', async () => {
    // The customer's shape: 1930 (primary) and 1931 (savings) both connected
    // at SEB; the SEK invoice default prints 1931, so settings carry 1931.
    const rows = [
      account({
        bank_connection_id: 'bc-1',
        iban: IBAN_1930,
        bank_connection: { bank_name: 'SEB', bic: 'ESSESESS' },
      }),
      account({
        id: 'ca-1931',
        name: 'Sparkonto',
        ledger_account: '1931',
        is_primary: false,
        bank_connection_id: 'bc-1',
        iban: IBAN_1931,
        payee_iban: IBAN_1931,
        bank_connection: { bank_name: 'SEB', bic: 'ESSESESS' },
      }),
    ]
    const { result } = resolve(rows, { iban: IBAN_1931, bic: 'ESSESESS' })

    expect(await result).toEqual({
      ok: true,
      account: {
        cash_account_id: 'ca-1930',
        name: 'Företagskonto',
        ledger_account: '1930',
        iban_last4: '7466',
        iban: IBAN_1930,
        bic: 'ESSESESS',
        bic_derived: false,
      },
    })
  })

  it('pays a booked run from the account its verifikat credits, whatever the primary is today', async () => {
    const rows = [
      account({ payee_iban: IBAN_1930 }),
      account({ id: 'ca-1931', name: 'Lönekonto', ledger_account: '1931', is_primary: false, payee_iban: IBAN_1931 }),
    ]
    const { result, calls } = resolve(rows, null, '1931')

    const resolution = await result
    expect(resolution).toMatchObject({ ok: true, account: { cash_account_id: 'ca-1931', ledger_account: '1931', iban: IBAN_1931 } })
    // The verifikat decides: the primary is never asked.
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'is_primary')).toHaveLength(0)
  })

  it("takes a connected account's bank-reported IBAN before an entered one, and a manual account's entered IBAN first", async () => {
    const connected = await resolve(
      [account({ bank_connection_id: 'bc-1', iban: IBAN_1930, payee_iban: IBAN_1931 })],
      null,
    ).result
    expect(connected).toMatchObject({ ok: true, account: { iban: IBAN_1930 } })

    const manual = await resolve([account({ iban: IBAN_1930, payee_iban: IBAN_1931 })], null).result
    expect(manual).toMatchObject({ ok: true, account: { iban: IBAN_1931 } })

    // Each falls back to the other.
    const connectedEntered = await resolve([account({ bank_connection_id: 'bc-1', payee_iban: IBAN_1931 })], null).result
    expect(connectedEntered).toMatchObject({ ok: true, account: { iban: IBAN_1931 } })
    const manualReported = await resolve([account({ iban: ' se45 5000 0000 0583 9825 7466 ' })], null).result
    expect(manualReported).toMatchObject({ ok: true, account: { iban: IBAN_1930 } })
  })

  it('borrows the settings IBAN and BIC when the account has none and is the only SEK bank account', async () => {
    const resolution = await resolve([account()], { iban: IBAN_1931, bic: 'ESSESESS' }).result
    expect(resolution).toEqual({
      ok: true,
      account: {
        cash_account_id: 'ca-1930',
        name: 'Företagskonto',
        ledger_account: '1930',
        iban_last4: '4567',
        iban: IBAN_1931,
        // The BIC saved beside that IBAN, as before: no lookup, no warning.
        bic: 'ESSESESS',
        bic_derived: false,
      },
    })
  })

  it('still borrows the settings IBAN once the company adds a card: a card is no bank account the IBAN could belong to', async () => {
    const card = account({ id: 'ca-card', name: 'Företagskort', ledger_account: '2890', is_primary: false, kind: 'card' })
    const { calls, result } = resolve([account(), card], { iban: IBAN_1931, bic: 'ESSESESS' })
    expect(await result).toMatchObject({ ok: true, account: { cash_account_id: 'ca-1930', ledger_account: '1930', iban: IBAN_1931 } })
    expect(calls.some((c) => c.table === 'cash_accounts' && c.method === 'eq' && c.args[0] === 'kind' && c.args[1] === 'bank')).toBe(true)
  })

  it('borrows the settings IBAN for a company with no cash accounts at all, on the historical 1930', async () => {
    const resolution = await resolve([], { iban: IBAN_1930, bic: null }).result
    expect(resolution).toEqual({
      ok: true,
      account: {
        cash_account_id: null,
        name: null,
        ledger_account: '1930',
        iban_last4: '7466',
        iban: IBAN_1930,
        bic: 'ESSESESS',
        bic_derived: true,
      },
    })
  })

  it('refuses rather than borrow when the company has several SEK bank accounts, naming the account', async () => {
    const rows = [
      account(),
      account({ id: 'ca-1931', name: 'Sparkonto', ledger_account: '1931', is_primary: false, payee_iban: IBAN_1931 }),
    ]
    const resolution = await resolve(rows, { iban: IBAN_1931, bic: 'ESSESESS' }).result
    expect(resolution).toEqual({
      ok: false,
      missing: 'iban',
      account: { cash_account_id: 'ca-1930', name: 'Företagskonto', ledger_account: '1930', iban_last4: null },
    })
    if (resolution.ok) return
    expect(payingAccountMissingSv(resolution.missing, resolution.account)).toBe(
      'Betalfilen betalar från Företagskonto (1930), men kontot saknar IBAN. Fyll i kontots IBAN under Inställningar → Fakturor, Bankkonton för kundfakturor.',
    )
  })

  it('refuses a booked verifikat account that has no cash account row, naming the ledger account', async () => {
    const rows = [account({ ledger_account: '1931', id: 'ca-1931', payee_iban: IBAN_1931 })]
    const resolution = await resolve(rows, { iban: IBAN_1930 }, '1930').result
    expect(resolution).toEqual({
      ok: false,
      missing: 'iban',
      account: { cash_account_id: null, name: null, ledger_account: '1930', iban_last4: null },
    })
    if (resolution.ok) return
    expect(payingAccountMissingSv(resolution.missing, resolution.account)).toBe(
      'Betalfilen betalar från konto 1930, men inget bankkonto med IBAN hör till det. Lägg till bankkontot och dess IBAN under Inställningar → Fakturor, Bankkonton för kundfakturor.',
    )
  })

  it('falls back to the only enabled SEK account when the primary cannot carry a payment, as the booking does', async () => {
    const rows = [
      account({ enabled: false, payee_iban: IBAN_1930 }),
      account({ id: 'ca-1931', name: 'Lönekonto', ledger_account: '1931', is_primary: false, payee_iban: IBAN_1931 }),
    ]
    const resolution = await resolve(rows, null).result
    expect(resolution).toMatchObject({ ok: true, account: { cash_account_id: 'ca-1931', ledger_account: '1931', iban: IBAN_1931 } })
  })

  describe('BIC', () => {
    it('takes the BIC saved on the account first, then the one the bank connection names', async () => {
      const saved = await resolve(
        [account({ payee_iban: IBAN_1930, bic: 'handsess', bank_connection: { bank_name: null, bic: 'NDEASESS' } })],
        null,
      ).result
      expect(saved).toMatchObject({ ok: true, account: { bic: 'HANDSESS', bic_derived: false } })

      const named = await resolve(
        [account({ bank_connection_id: 'bc-1', iban: IBAN_1930, bank_connection: { bank_name: 'Lunar', bic: 'LUNADK2B' } })],
        null,
      ).result
      expect(named).toMatchObject({ ok: true, account: { bic: 'LUNADK2B', bic_derived: false } })
    })

    it("derives the BIC from the IBAN's bank code, then the clearing number, then the bank name, and says so", async () => {
      const fromIban = await resolve([account({ payee_iban: IBAN_1930, clearing_number: '6000' })], null).result
      expect(fromIban).toMatchObject({ ok: true, account: { bic: 'ESSESESS', bic_derived: true } })

      const foreignIban = 'DK5000400440116243'
      const fromClearing = await resolve([account({ payee_iban: foreignIban, clearing_number: '6000' })], null).result
      expect(fromClearing).toMatchObject({ ok: true, account: { bic: 'HANDSESS', bic_derived: true } })

      const fromName = await resolve([account({ payee_iban: foreignIban, bank_name: 'Länsförsäkringar Bank' })], null)
        .result
      expect(fromName).toMatchObject({ ok: true, account: { bic: 'ELLFSESS', bic_derived: true } })
      if (!fromName.ok) return
      expect(derivedBicWarningSv(fromName.account)).toBe(
        'BIC (ELLFSESS) för Företagskonto (1930) härleddes från kontots IBAN, clearingnummer eller banknamn. Spara BIC under Inställningar → Fakturor, Bankkonton för kundfakturor om banken avvisar filen.',
      )
    })

    it("never pairs the settings BIC with an account's own IBAN", async () => {
      const resolution = await resolve([account({ payee_iban: IBAN_1930 })], { iban: IBAN_1931, bic: 'NDEASESS' }).result
      expect(resolution).toMatchObject({ ok: true, account: { iban: IBAN_1930, bic: 'ESSESESS', bic_derived: true } })
    })

    it('refuses a bank it cannot name, naming the account', async () => {
      const resolution = await resolve([account({ payee_iban: 'DK5000400440116243' })], null).result
      expect(resolution).toEqual({
        ok: false,
        missing: 'bic',
        account: { cash_account_id: 'ca-1930', name: 'Företagskonto', ledger_account: '1930', iban_last4: '6243' },
      })
    })
  })

  it('throws on a failed account read instead of guessing an account', async () => {
    const mock = createTableMockSupabase({
      cash_accounts: (chain) =>
        chain.some((c) => c.method === 'eq' && c.args[0] === 'is_primary')
          ? { data: account() }
          : { error: { message: 'boom' } },
    })
    await expect(
      resolvePayingAccount(mock.supabase as unknown as SupabaseClient, COMPANY_ID, log, { settings: null }),
    ).rejects.toMatchObject({ name: 'BookkeepingDatabaseError', operation: 'resolve_paying_account' })
  })
})
