/**
 * Cutover parity: the categorized vacation fields (migration
 * 20260919130000) must not move a single figure for a company that never
 * sends them.
 *
 * The expected values below were captured from the code BEFORE the
 * categorized fields existed (ledger upsert payload, liability report,
 * payslip data) and are kept verbatim. The assertions compare every
 * pre-existing key byte for byte; the new keys may appear only at their
 * neutral defaults (0, {} or null), which is what a stored row without the
 * columns reads as after the migration.
 *
 * Fixtures deliberately use the legacy row shapes: the opening row lacks
 * vacation_as_of_date and every *_days_remaining pool, the booked run rows
 * lack embedded line items, and the payslip row has a numeric ytd_net.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncVacationLedgerForEmployees } from '@/lib/salary/vacation-ledger'
import { generateVacationLiability } from '@/lib/reports/vacation-liability'

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: vi.fn((v: string) => v),
  maskPersonnummer: vi.fn(() => '19900101-****'),
}))

import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

interface TableResp {
  data?: unknown
  error?: unknown
}

/**
 * Per-table response queues: each `from(table)` call shifts the next queued
 * response for that table (the last one repeats). Unlike the positional
 * queue helper, an extra query the implementation adds later cannot shift
 * every other fixture out of place, which is what a parity test needs.
 * Writes (upsert/insert/update) are recorded per table.
 */
function makeTableMock(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [table, value] of Object.entries(byTable)) {
    queues.set(table, Array.isArray(value) ? [...value] : [value])
  }
  const writes: Array<{ table: string; method: string; payload: unknown }> = []
  const buildChain = (table: string, result: TableResp): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: result.data ?? null, error: result.error ?? null })
        }
        return (...args: unknown[]) => {
          if (prop === 'upsert' || prop === 'insert' || prop === 'update') {
            writes.push({ table, method: String(prop), payload: args[0] })
          }
          return buildChain(table, result)
        }
      },
    }
    return new Proxy({}, handler)
  }
  const from = (table: string) => {
    const queue = queues.get(table)
    const next = queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? { data: null })
    return buildChain(table, next)
  }
  return { supabase: { from } as unknown as SupabaseClient, writes }
}

const LEGACY_OPENING_ROW = {
  employee_id: EMPLOYEE_ID,
  cutover_date: '2026-07-01',
  vacation_paid_days_remaining: 12.5,
  vacation_days_taken_this_year: 7,
  vacation_saved_days_by_year: { '2025': 5, '2024': 2 },
  opening_semester_liability: 42000,
  opening_semester_liability_avgifter: 13196.4,
}

/**
 * The keys the categorized model adds. A legacy fixture must produce them at
 * exactly these neutral values and nothing else may differ.
 */
const NEW_LEDGER_DEFAULTS = { unpaid_days: 0, advance_days: 0, saved_days_taken: {} }
// netLiability equals totalLiability whenever no förskottsskuld is loaded, so
// its neutral value is the captured total, not zero.
const NEW_LIABILITY_ROW_DEFAULTS = { advanceVacationDebt: 0, netLiability: 66235.68 }
const NEW_LIABILITY_TOTALS_DEFAULTS = { advanceVacationDebt: 0, netLiability: 66235.68 }

function omit<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v
  return out
}

const LEGACY_BOOKED_ROWS = [
  {
    employee_id: EMPLOYEE_ID,
    vacation_days_taken: 3,
    vacation_accrual: 4200,
    vacation_accrual_avgifter: 1319.64,
    avgifter_rate: 0.3142,
    salary_run: { period_year: 2026, period_month: 7, status: 'booked' },
  },
  {
    employee_id: EMPLOYEE_ID,
    vacation_days_taken: 2,
    vacation_accrual: 4200,
    vacation_accrual_avgifter: 1319.64,
    avgifter_rate: 0.3142,
    salary_run: { period_year: 2026, period_month: 8, status: 'booked' },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('cutover parity: ledger sync without categorized fields', () => {
  it('seeds and recomputes the cutover-year row exactly as before', async () => {
    const mock = makeTableMock({
      company_settings: { data: { salary_vacation_year_basis: 'calendar' } },
      employees: {
        data: [
          {
            id: EMPLOYEE_ID,
            vacation_days_per_year: 25,
            vacation_days_saved: 0,
            vacation_rule: 'procentregeln',
            employment_start: '2015-01-01',
          },
        ],
      },
      employee_opening_balances: { data: [LEGACY_OPENING_ROW] },
      employee_vacation_balances: [
        {
          data: [
            {
              id: 'row-1',
              employee_id: EMPLOYEE_ID,
              vacation_year_start: '2026-01-01',
              entitled_days: 10,
              accrued_days: 0,
              taken_days: 0,
              saved_days: { '2025': 5, '2024': 2 },
              forced_payout_days: 0,
              status: 'open',
            },
          ],
        },
        { data: null },
      ],
      salary_run_employees: { data: LEGACY_BOOKED_ROWS },
    })

    const result = await syncVacationLedgerForEmployees(mock.supabase, COMPANY_ID, [EMPLOYEE_ID], '2026-09-13')
    expect(result.ok).toBe(true)
    const upsert = mock.writes.find((w) => w.table === 'employee_vacation_balances' && w.method === 'upsert')
    const rows = upsert?.payload as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    // New pools at their neutral defaults only.
    expect(rows[0]).toMatchObject(NEW_LEDGER_DEFAULTS)
    // Everything that existed before: byte for byte the captured output.
    expect(rows.map((row) => omit(row, Object.keys(NEW_LEDGER_DEFAULTS)))).toMatchInlineSnapshot(`
      [
        {
          "accrued_days": 0,
          "company_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "employee_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "entitled_days": 19.5,
          "forced_payout_days": 0,
          "saved_days": {
            "2024": 2,
            "2025": 5,
          },
          "status": "open",
          "taken_days": 12,
          "vacation_year_start": "2026-01-01",
        },
      ]
    `)
  })
})

describe('cutover parity: vacation liability without categorized fields', () => {
  it('reports the same rows and totals', async () => {
    const mock = makeTableMock({
      employees: {
        data: [
          {
            id: EMPLOYEE_ID,
            first_name: 'Anna',
            last_name: 'Andersson',
            personnummer_last4: '0000',
            vacation_rule: 'procentregeln',
            vacation_days_per_year: 25,
            vacation_days_saved: 0,
          },
        ],
      },
      salary_run_employees: { data: LEGACY_BOOKED_ROWS },
      employee_vacation_balances: {
        data: [
          {
            employee_id: EMPLOYEE_ID,
            vacation_year_start: '2026-01-01',
            entitled_days: 19.5,
            taken_days: 12,
            saved_days: { '2025': 5, '2024': 2 },
          },
        ],
      },
      employee_opening_balances: { data: [LEGACY_OPENING_ROW] },
    })

    const report = await generateVacationLiability(mock.supabase, COMPANY_ID, 2026)
    expect(report.totals).toMatchObject(NEW_LIABILITY_TOTALS_DEFAULTS)
    for (const row of report.rows) expect(row).toMatchObject(NEW_LIABILITY_ROW_DEFAULTS)
    const legacyShape = {
      ...report,
      rows: report.rows.map((row) => omit(row as unknown as Record<string, unknown>, Object.keys(NEW_LIABILITY_ROW_DEFAULTS))),
      totals: omit(report.totals as unknown as Record<string, unknown>, Object.keys(NEW_LIABILITY_TOTALS_DEFAULTS)),
    }
    expect(legacyShape).toMatchInlineSnapshot(`
      {
        "asOfDate": "2026-12-31",
        "rows": [
          {
            "accruedAmount": 50400,
            "accruedAvgifter": 15835.68,
            "avgifterRate": 0.3142,
            "employeeId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "employeeName": "Anna Andersson",
            "personnummerLast4": "0000",
            "totalLiability": 66235.68,
            "vacationDaysEntitled": 19.5,
            "vacationDaysRemaining": 7.5,
            "vacationDaysSaved": 7,
            "vacationDaysTaken": 12,
            "vacationRule": "procentregeln",
          },
        ],
        "totals": {
          "accruedAmount": 50400,
          "accruedAvgifter": 15835.68,
          "totalLiability": 66235.68,
        },
      }
    `)
  })
})

describe('cutover parity: payslip data with a known net', () => {
  it('builds the same payslip data', () => {
    const data = buildPayslipData({
      run: { period_year: 2026, period_month: 8, payment_date: '2026-08-25' },
      sre: {
        gross_salary: 35000,
        tax_withheld: 8000,
        tax_withheld_override: null,
        avgifter_rate: 0.3142,
        avgifter_amount: 10997,
        avgifter_amount_override: null,
        avgifter_basis_override: null,
        override_reason: null,
        net_salary: 27000,
        vacation_accrual: 4200,
        vacation_accrual_avgifter: 1319.74,
        ytd_gross: 210000,
        ytd_tax: 48000,
        ytd_net: 162000,
        calculation_breakdown: { steps: [{ label: 'Bruttolön', formula: '35000', output: 35000 }] },
        line_items: [{ description: 'Grundlön', amount: 35000, sort_order: 0 }],
      },
      employee: {
        first_name: 'Anna',
        last_name: 'Exempelsson',
        personnummer: 'enc',
        employment_type: 'employee',
        tax_table_number: 33,
        tax_column: 1,
        clearing_number: '8327',
        bank_account_number: '9876543',
      },
      company: { name: 'Bolaget AB', org_number: '5560000000' },
    })
    expect(data).toMatchInlineSnapshot(`
      {
        "avgifterAmount": 10997,
        "avgifterRate": 0.3142,
        "bankAccount": "8327-****6543",
        "breakdownSteps": [
          {
            "formula": "35000",
            "label": "Bruttolön",
            "output": 35000,
          },
        ],
        "companyName": "Bolaget AB",
        "companyOrgNumber": "5560000000",
        "deviationPeriodLabel": null,
        "employeeName": "Anna Exempelsson",
        "employmentType": "Anställd",
        "grossSalary": 35000,
        "lineItems": [
          {
            "amount": 35000,
            "description": "Grundlön",
            "quantity": undefined,
            "unitPrice": undefined,
          },
        ],
        "netSalary": 27000,
        "paymentDate": "2026-08-25",
        "periodMonth": 8,
        "periodYear": 2026,
        "personnummerMasked": "19900101-****",
        "taxReference": "Tabell 33, kol 1",
        "taxWithheld": 8000,
        "totalEmployerCost": 51516.74,
        "vacationAccrual": 4200,
        "vacationAccrualAvgifter": 1319.74,
        "ytdGross": 210000,
        "ytdNet": 162000,
        "ytdTax": 48000,
      }
    `)
  })
})
