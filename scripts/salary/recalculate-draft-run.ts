#!/usr/bin/env npx tsx
/**
 * Support one-shot: recalculate a customer's DRAFT salary run ("Räkna om").
 *
 * WHY: a draft's stored totals are only as fresh as its last calculation.
 * When a calculation rule is fixed, or a payslip line is changed without a
 * recalculation, the draft keeps the old totals until someone presses "Räkna
 * om". The customer can do that themselves; this lets support do it for them,
 * without being a member of the customer's company, using the service-role
 * key. It calls the same runSalaryCalculation the product calls: there is no
 * second implementation of the payroll math here.
 *
 * DRAFT ONLY. Any other status is refused. A run past draft has been
 * reviewed, approved, paid or booked on its stored totals; it goes back to
 * draft in the product (revert) or through a correction run, never here.
 *
 * DRY RUN BY DEFAULT: prints each payslip's stored rows and stored totals and
 * changes nothing. It prints every bruttolöneavdrag row and FLAGS one that
 * equals, to the öre, what the employee's benefit payment takes off the
 * förmånsvärde. That is the workaround customers used before the engine
 * reduced the förmånsvärde itself; recalculating with it in place lowers the
 * tax base twice. --apply refuses a flagged run until a person has looked and
 * passes --acknowledge-gross-deduction (a real bruttolöneavdrag of the same
 * amount is legitimate, and only a person can tell).
 *
 * The flag reads the STORED rows. Benefit and recurring rows are re-derived
 * from their registers on recalculation, so the employee's active recurring
 * deductions are printed next to them: if the workaround is still in the
 * register it comes back every month until the customer removes it there.
 *
 * IDEMPOTENT: the calculation is a pure function of the payslip rows and the
 * registers; derived rows are deleted and re-inserted by back-link. A second
 * --apply writes the same totals.
 *
 * Usage:
 *   # Dry run (default): prints rows, totals and flags; writes nothing.
 *   npx tsx scripts/salary/recalculate-draft-run.ts --company <uuid> --run <uuid>
 *
 *   # Recalculate, print totals before and after and the calculation warnings.
 *   npx tsx scripts/salary/recalculate-draft-run.ts --company <uuid> --run <uuid> --apply
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION: run the dry run first and read
 * it before passing --apply.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACKNOWLEDGE = '--acknowledge-gross-deduction'

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}

const USAGE = `Usage: npx tsx scripts/salary/recalculate-draft-run.ts --company <uuid> --run <uuid> [--apply] [${ACKNOWLEDGE}]`

const COMPANY_ID = argValue('--company')?.trim() ?? null
const RUN_ID = argValue('--run')?.trim() ?? null
const APPLY = process.argv.includes('--apply')
const ACKNOWLEDGED = process.argv.includes(ACKNOWLEDGE)

// Refuse before touching env or the network: a run without an explicit
// company and salary run is never what support meant.
if (!COMPANY_ID || !RUN_ID) {
  console.error('--company <uuid> and --run <uuid> are both required: this script never sweeps.')
  console.error(USAGE)
  process.exit(1)
}
if (!UUID_RE.test(COMPANY_ID)) {
  console.error(`--company must be a uuid, got: ${COMPANY_ID}`)
  process.exit(1)
}
if (!UUID_RE.test(RUN_ID)) {
  console.error(`--run must be a uuid, got: ${RUN_ID}`)
  process.exit(1)
}

dotenv({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as SupabaseClient

const TOTAL_COLUMNS = [
  'gross_salary',
  'gross_deductions',
  'benefit_values',
  'taxable_income',
  'tax_withheld',
  'net_deductions',
  'net_salary',
  'avgifter_basis',
  'avgifter_amount',
] as const

type Totals = Record<(typeof TOTAL_COLUMNS)[number], number>

// Run-level totals: the only before/after there is for an empty roster.
const RUN_TOTAL_COLUMNS = [
  'total_gross',
  'total_tax',
  'total_net',
  'total_avgifter',
  'total_vacation_accrual',
  'total_employer_cost',
] as const

function printRunTotals(label: string, run: Record<string, unknown>) {
  console.log(`  ${label}`)
  for (const column of RUN_TOTAL_COLUMNS) console.log(`    ${column.padEnd(24)} ${String(run[column] ?? '-').padStart(12)}`)
}

interface PayslipRow extends Totals {
  id: string
  employee_id: string
  employee: { first_name: string; last_name: string } | null
  line_items: Array<{
    item_type: string
    description: string | null
    amount: number
    is_gross_deduction: boolean | null
    source_benefit_id: string | null
    source_recurring_line_id: string | null
    sort_order: number | null
  }>
}

async function loadPayslips(): Promise<PayslipRow[]> {
  const { data, error } = await supabase
    .from('salary_run_employees')
    .select(
      `id, employee_id, ${TOTAL_COLUMNS.join(', ')}, employee:employees(first_name, last_name), ` +
        'line_items:salary_line_items(item_type, description, amount, is_gross_deduction, source_benefit_id, source_recurring_line_id, sort_order)',
    )
    .eq('salary_run_id', RUN_ID)
    .eq('company_id', COMPANY_ID)
  if (error) {
    console.error(`Could not read salary_run_employees: ${error.message}`)
    process.exit(1)
  }
  return (data ?? []) as unknown as PayslipRow[]
}

const nameOf = (p: PayslipRow) => (p.employee ? `${p.employee.first_name} ${p.employee.last_name}` : p.employee_id)

function printTotals(label: string, totals: Totals) {
  console.log(`  ${label}`)
  for (const column of TOTAL_COLUMNS) console.log(`    ${column.padEnd(18)} ${String(totals[column]).padStart(12)}`)
}

async function main() {
  // Imported here, not at the top: static imports are hoisted above the
  // dotenv() call, and lib/supabase/server.ts captures NEXT_PUBLIC_SUPABASE_URL
  // into a module constant when it is first evaluated. Loaded before the env,
  // that constant is undefined and service clients built from it fail (the
  // bug PR #2628 fixed in refresh-supplier-payment-state.ts).
  const { recalculationRefusal, inspectStoredPayslip, applyRefusal, describeRow, ACKNOWLEDGE_FLAG } = await import(
    '../../src/lib/salary/recalculate-draft-run'
  )
  // The flag is parsed above, before any app import; the refusal text that
  // names it lives in the lib. One name, checked rather than trusted.
  if (ACKNOWLEDGE_FLAG !== ACKNOWLEDGE) {
    throw new Error(`Flag name drift: script parses ${ACKNOWLEDGE}, lib documents ${ACKNOWLEDGE_FLAG}`)
  }

  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    // ONE string literal on purpose: supabase-js types the row by parsing the
    // literal type of this argument. A template or a '+' concatenation is just
    // `string` to the compiler and the row becomes an error type.
    .select('id, company_id, status, period_year, period_month, payment_date, total_gross, total_tax, total_net, total_avgifter, total_vacation_accrual, total_employer_cost')
    .eq('id', RUN_ID)
    .maybeSingle()
  if (runError) {
    console.error(`Could not read salary_runs: ${runError.message}`)
    process.exit(1)
  }
  const refusal = recalculationRefusal(run, COMPANY_ID!)
  if (refusal) {
    console.error(`REFUSED: ${refusal}`)
    process.exit(1)
  }

  console.log('---------------------------------------------------------')
  console.log('Recalculate draft salary run')
  console.log('---------------------------------------------------------')
  console.log('Supabase URL :', SUPABASE_URL)
  console.log('Company      :', COMPANY_ID)
  console.log('Salary run   :', `${RUN_ID} (${run!.period_year}-${String(run!.period_month).padStart(2, '0')}, payout ${run!.payment_date}, status ${run!.status})`)
  console.log('Mode         :', APPLY ? 'APPLY (recalculates and writes)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------')

  const before = await loadPayslips()
  if (before.length === 0) {
    // Not a refusal. runSalaryCalculation treats an empty roster as valid (a
    // registered employer still files a nolldeklaration) and writes all-zero
    // totals plus the calculation_params snapshot, which is exactly what a
    // draft whose employees were all removed needs.
    console.log('\nThe salary run has no payslips: an empty roster. Recalculating writes all-zero run totals.')
  }

  console.log('\nSalary run')
  printRunTotals('Stored run totals:', run as unknown as Record<string, unknown>)

  let flaggedCount = 0
  for (const payslip of before) {
    console.log(`\n${nameOf(payslip)}`)
    console.log('  Stored rows (what the last calculation produced):')
    const rows = [...payslip.line_items].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    for (const row of rows) console.log(`    ${describeRow(row)}`)
    printTotals('Stored totals:', payslip)

    const inspection = inspectStoredPayslip(rows)
    if (inspection.resolutionError) {
      console.log(`  !! The calculation will REFUSE this payslip: ${inspection.resolutionError}`)
    }
    if (inspection.grossDeductions.length > 0) {
      console.log('  Bruttolöneavdrag rows (read these before --apply):')
      for (const row of inspection.grossDeductions) {
        const flagged = inspection.flagged.includes(row)
        console.log(`    ${flagged ? '!! FLAGGED' : '          '} ${describeRow(row)}`)
      }
    }
    if (inspection.flagged.length > 0) {
      flaggedCount += inspection.flagged.length
      console.log(
        "  !! FLAGGED = equals, to the öre, what the employee's benefit payment takes off the förmånsvärde. " +
          'The likely pre-fix workaround: recalculating with it lowers the tax base twice (tax and avgifter too low).',
      )
    }

    // What the recalculation will re-derive from, so a stale stored row and a
    // workaround that returns every month are both visible.
    const { data: recurring, error: recurringError } = await supabase
      .from('employee_recurring_lines')
      .select('item_type, description, amount, valid_from, valid_to')
      .eq('employee_id', payslip.employee_id)
      .eq('company_id', COMPANY_ID)
      .eq('is_active', true)
    if (recurringError) {
      console.error(`Could not read employee_recurring_lines: ${recurringError.message}`)
      process.exit(1)
    }
    if ((recurring ?? []).length > 0) {
      console.log('  Active recurring lines in the register (re-derived on recalculation, return every month):')
      for (const line of recurring ?? []) {
        console.log(
          `    ${String(line.item_type).padEnd(32)} ${String(line.amount).padStart(12)}  ${line.valid_from} to ${line.valid_to ?? 'open'}  ${line.description ?? ''}`,
        )
      }
    }
  }

  console.log('')
  if (!APPLY) {
    console.log('DRY RUN: nothing was written.')
    if (flaggedCount > 0) {
      console.log(`${flaggedCount} row(s) FLAGGED above. ${applyRefusal(flaggedCount, false)}`)
    } else {
      console.log('Re-run with --apply to recalculate.')
    }
    return
  }

  const stop = applyRefusal(flaggedCount, ACKNOWLEDGED)
  if (stop) {
    console.error(`REFUSED: ${stop}`)
    process.exit(1)
  }

  const { runSalaryCalculation } = await import('../../src/lib/salary/run-calculation')
  const { createLogger } = await import('../../src/lib/logger')
  const result = await runSalaryCalculation({
    supabase,
    companyId: COMPANY_ID!,
    salaryRunId: RUN_ID!,
    log: createLogger('scripts.salary.recalculate-draft-run'),
    requestId: `support-recalculate-${RUN_ID}`,
  })
  if (!result.ok) {
    console.error(`Calculation failed: ${result.code}`)
    console.error(JSON.stringify(result.details ?? null, null, 2))
    process.exit(1)
  }

  console.log('\nSalary run')
  printRunTotals('Before:', run as unknown as Record<string, unknown>)
  printRunTotals('After:', result.run)

  const after = await loadPayslips()
  for (const payslip of after) {
    const previous = before.find((p) => p.id === payslip.id)
    console.log(`\n${nameOf(payslip)}`)
    if (previous) printTotals('Before:', previous)
    printTotals('After:', payslip)
  }

  console.log('')
  if (result.warnings.length > 0) {
    console.log('Calculation warnings (the customer sees these on "Räkna om" too):')
    for (const warning of result.warnings) console.log(`  !! ${warning}`)
  } else {
    console.log('No calculation warnings.')
  }
  console.log(`\nDone. Recalculated ${after.length} payslip(s) on draft run ${RUN_ID}.`)
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
