/**
 * The measure tests' aktiebolag (lib/measures/__tests__/fixtures.ts) with
 * what the checks read besides the ledger: a VAT-registered company with two
 * declared quarters, a bank account the bank reported a balance for, bank
 * rows, the skattekonto rows and Skatteverket's saldo, and the invoice and
 * supplier invoice registers linked to their verifikat.
 *
 * The base state is ok for every check that can run, except the two the
 * measure fixture already leaves open (each test names its own state):
 *   - receivables_vs_ledger: invoice 1002 (3 000 open) has no verifikat;
 *   - vat_declared_not_settled: Q2 2026 is declared but not settled.
 * Builders below add one discrepancy at a time.
 */
import type { FakeEntry, FakeLedgerData } from '@/lib/measures/__tests__/fake-ledger'
import { CO, FP, INV1, SINV1, fixtureData } from '@/lib/measures/__tests__/fixtures'

export { CO, FP }

export const TODAY = '2026-10-16'
export const CA_1930 = 'ca000000-0000-4000-8000-000000000001'
export const CA_1940 = 'ca000000-0000-4000-8000-000000000002'
export const TXN1 = 'd0000000-0000-4000-8000-000000000001'
export const SKV_ENTRY = 'e0000000-0000-4000-8000-000000000301'
export const SKV_ROW1 = '5c000000-0000-4000-8000-000000000001'
export const SKV_ROW2 = '5c000000-0000-4000-8000-000000000002'
export const MANUAL_AR = 'e0000000-0000-4000-8000-000000000401'
export const MANUAL_AP = 'e0000000-0000-4000-8000-000000000402'

const E6 = 'e0000000-0000-4000-8000-000000000006'

type Row = Record<string, unknown>

export interface CheckFixtureOptions {
  accountingMethod?: 'accrual' | 'cash'
  vatRegistered?: boolean
  jurisdiction?: string
  /** Declared VAT periods as deadline tax_period labels. */
  declared?: string[]
  /** The 1930 balance the bank reported, and when; null = none reported. */
  bankBalance?: { amount: number; at: string } | null
  transactions?: Row[]
  /** Skatteverket saldo snapshot; null = never fetched. */
  skvSaldo?: { amount: number; at: string } | null
  skvRows?: Row[]
  extraEntries?: FakeEntry[]
  invoices?: Row[]
  supplierInvoices?: Row[]
}

/** The two declared quarters as the deadline rows the filing store reads. */
function deadlineRows(labels: string[]): Row[] {
  return labels.map((label, i) => ({
    id: `dd000000-0000-4000-8000-00000000000${i + 1}`,
    company_id: CO,
    tax_deadline_type: 'moms_quarterly',
    tax_period: label,
    is_completed: true,
    completed_at: '2026-08-10T12:00:00.000Z',
    status: 'submitted',
    notes: null,
    due_date: '2026-08-17',
    dismissed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
  }))
}

/** One unbooked bank row on 1930: 1 000 in, dated 2026-06-29, not triaged. */
export function unbookedRow(overrides: Row = {}): Row {
  return {
    id: TXN1,
    company_id: CO,
    cash_account_id: CA_1930,
    date: '2026-06-29',
    description: 'Swish från kund',
    amount: 1000,
    currency: 'SEK',
    is_ignored: false,
    is_business: null,
    journal_entry_id: null,
    is_booked: false,
    created_at: '2026-06-29T10:00:00.000Z',
    ...overrides,
  }
}

/** The skattekonto payment: 5 000 from 1930 to 1630, booked and linked. */
const SKV_PAYMENT: FakeEntry = {
  id: SKV_ENTRY,
  entry_date: '2026-05-10',
  voucher_number: 30,
  description: 'Inbetalning skattekonto',
  source_type: 'bank_transaction',
  fiscal_period_id: FP,
  lines: [
    { account_number: '1630', debit: 5000 },
    { account_number: '1930', credit: 5000 },
  ],
}

export function skvRow(overrides: Row = {}): Row {
  return {
    id: SKV_ROW1,
    company_id: CO,
    transaktionsdatum: '2026-05-10',
    forfallodatum: null,
    transaktionstext: 'Inbetalning bokförd',
    belopp_skatteverket: 5000,
    status: 'booked',
    journal_entry_id: SKV_ENTRY,
    suggested_journal_entry_id: null,
    is_ignored: false,
    ...overrides,
  }
}

/** A manual verifikat on 1510 no invoice knows: 700 debited against sales. */
export const MANUAL_RECEIVABLE: FakeEntry = {
  id: MANUAL_AR,
  entry_date: '2026-07-01',
  voucher_number: 40,
  description: 'Manuell kundfordran',
  source_type: 'manual',
  fiscal_period_id: FP,
  lines: [
    { account_number: '1510', debit: 700 },
    { account_number: '3001', credit: 700 },
  ],
}

/** A manual verifikat on 2440 no supplier invoice knows: 1 500 credited. */
export const MANUAL_PAYABLE: FakeEntry = {
  id: MANUAL_AP,
  entry_date: '2026-07-02',
  voucher_number: 41,
  description: 'Manuell leverantörsskuld',
  source_type: 'manual',
  fiscal_period_id: FP,
  lines: [
    { account_number: '6110', debit: 1500 },
    { account_number: '2440', credit: 1500 },
  ],
}

export function checkFixture(options: CheckFixtureOptions = {}): FakeLedgerData {
  const base = fixtureData()
  // The Q1 momsredovisning booked on the period's last day, with the text the
  // app gives it, so Q1 reads as settled and Q2 (nothing booked) as open.
  const entries = base.entries.map((e) =>
    e.id === E6 ? { ...e, entry_date: '2026-03-31', description: 'Momsredovisning Kvartal 1 2026' } : e,
  )
  const skvConnected = options.skvSaldo !== undefined || options.skvRows !== undefined
  if (skvConnected) entries.push(SKV_PAYMENT)
  entries.push(...(options.extraEntries ?? []))

  const bank = options.bankBalance === undefined ? { amount: 55350, at: '2026-06-30T10:00:00.000Z' } : options.bankBalance
  const skv = options.skvSaldo

  return {
    ...base,
    jurisdiction: options.jurisdiction ?? 'SE',
    chart: [
      ...base.chart,
      { account_number: '1630', account_name: 'Avräkning för skatter och avgifter (skattekonto)', account_class: 1 },
    ],
    entries,
    invoices: options.invoices ?? (base.invoices ?? []).map((inv) => (inv.id === INV1 ? { ...inv, journal_entry_id: 'e0000000-0000-4000-8000-000000000001' } : inv)),
    supplierInvoices:
      options.supplierInvoices ??
      (base.supplierInvoices ?? []).map((inv) =>
        inv.id === SINV1 ? { ...inv, registration_journal_entry_id: 'e0000000-0000-4000-8000-000000000002' } : inv,
      ),
    cashAccounts: [
      {
        id: CA_1930,
        name: 'Företagskonto',
        ledger_account: '1930',
        currency: 'SEK',
        iban: 'SE4550000000058398257466',
        enabled: true,
        balance: bank?.amount ?? null,
        balance_updated_at: bank?.at ?? null,
        updated_at: '2026-06-30T10:00:00.000Z',
      },
      {
        id: CA_1940,
        name: 'Sparkonto',
        ledger_account: '1940',
        currency: 'SEK',
        iban: null,
        enabled: true,
        balance: null,
        balance_updated_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      // A payment-provider clearing account: not a bank account, never checked.
      { id: 'ca000000-0000-4000-8000-000000000003', name: 'Stripe', ledger_account: '1686', currency: 'SEK', iban: null, enabled: true, balance: 900, balance_updated_at: '2026-06-30T10:00:00.000Z', updated_at: null },
    ],
    extraTables: {
      company_settings: [
        {
          company_id: CO,
          accounting_method: options.accountingMethod ?? 'accrual',
          vat_registered: options.vatRegistered ?? true,
          bookkeeping_locked_through: null,
          entity_type: 'aktiebolag',
          fiscal_year_start_month: 1,
          moms_period: 'quarterly',
        },
      ],
      deadlines: deadlineRows(options.declared ?? ['2026-Q1', '2026-Q2']),
      transactions: options.transactions ?? [],
      skattekonto_transactions: options.skvRows ?? (skvConnected ? [skvRow()] : []),
      extension_data: skv
        ? [
            {
              company_id: CO,
              extension_id: 'skatteverket',
              key: 'skattekonto_balance_snapshot',
              value: { saldo: { saldoSkatteverket: skv.amount }, fetchedAt: skv.at },
            },
          ]
        : [],
      invoice_payments: [],
      supplier_invoice_payments: [],
    },
  }
}
