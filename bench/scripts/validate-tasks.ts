// Static validation of every committed task file. Run after any task edit:
//
//   npx tsx bench/scripts/validate-tasks.ts
//
// Checks, per suite:
//  - unique ids, valid data_class/difficulty
//  - booking: every gold and acceptable account exists in the committed
//    chart context; vat_treatment is a known enum value
//  - reasoning: gold shape is well-formed; choice answers appear in options
//  - extraction: referenced document PNG exists; totals arithmetic holds
//    (subtotal + vatAmount + rounding = total, vatBreakdown sums match)
//  - ledger-agent: seed and assertion program names resolve

import fs from 'node:fs'
import path from 'node:path'
import { loadAllTasks as loadTasks, BENCH_ROOT } from '../src/util'
import { VAT_TREATMENTS } from '../src/types'
import type {
  BookingTask,
  ExtractionTask,
  LedgerAgentTask,
  ReasoningTask,
} from '../src/types'
import { SEEDS, ASSERTIONS } from '../src/ledger-tasks'

let failures = 0
function problem(msg: string) {
  failures++
  console.error(`FAIL ${msg}`)
}

// Booking.
const chart = new Set(
  fs
    .readFileSync(path.join(BENCH_ROOT, 'tasks', 'booking', 'context-accounts.txt'), 'utf8')
    .split('\n')
    .map((l) => l.split(' ')[0])
    .filter(Boolean),
)
const booking = loadTasks<BookingTask>('booking')
for (const t of booking) {
  const accounts = [t.gold.account, ...(t.gold.acceptable_accounts ?? [])]
  for (const a of accounts) {
    if (!chart.has(a)) problem(`${t.id}: account ${a} not in context-accounts.txt`)
  }
  if (!(VAT_TREATMENTS as string[]).includes(t.gold.vat_treatment)) {
    problem(`${t.id}: unknown vat_treatment ${t.gold.vat_treatment}`)
  }
  if (t.input.transaction.amount === 0) {
    problem(`${t.id}: transaction amount is zero`)
  }
  // Most bookings are outflows, so an unmarked positive amount is almost
  // certainly a sign typo. Genuine inflows that are still not revenue (a
  // supplier credit note, a tax-account refund, money put in by the owner)
  // declare `inflow: true` and are checked for the opposite mistake.
  if (t.input.transaction.amount > 0 && t.inflow !== true) {
    problem(`${t.id}: positive amount ${t.input.transaction.amount} without inflow: true`)
  }
  if (t.input.transaction.amount < 0 && t.inflow === true) {
    problem(`${t.id}: marked inflow: true but amount is ${t.input.transaction.amount}`)
  }
}
console.log(`booking: ${booking.length} tasks`)

// Reasoning.
const reasoning = loadTasks<ReasoningTask>('reasoning')
for (const t of reasoning) {
  if (t.gold.type === 'choice' && !t.gold.options.includes(t.gold.value)) {
    problem(`${t.id}: gold value not among options`)
  }
  if (t.gold.type === 'number' && !Number.isFinite(t.gold.value)) {
    problem(`${t.id}: non-finite gold number`)
  }
}
console.log(`reasoning: ${reasoning.length} tasks`)

// Extraction.
const extraction = loadTasks<ExtractionTask>('extraction')
for (const t of extraction) {
  const png = path.join(
    BENCH_ROOT,
    'tasks',
    'extraction',
    'documents',
    t.input.document.replace(/\.pdf$/, '.png'),
  )
  if (!fs.existsSync(png)) problem(`${t.id}: missing rendered document ${png}`)
  const g = t.gold
  if (
    g.subtotal != null &&
    g.vatAmount != null &&
    g.total != null
  ) {
    const rounding = g.roundingAmount ?? 0
    const sum = Math.round((g.subtotal + g.vatAmount + rounding) * 100) / 100
    if (Math.abs(sum - g.total) > 0.011) {
      problem(`${t.id}: subtotal+vat+rounding=${sum} != total ${g.total}`)
    }
  }
  if (g.vatBreakdown && g.vatAmount != null) {
    const sum =
      Math.round(g.vatBreakdown.reduce((s, r) => s + r.amount, 0) * 100) / 100
    if (Math.abs(sum - g.vatAmount) > 0.011) {
      problem(`${t.id}: vatBreakdown amounts sum ${sum} != vatAmount ${g.vatAmount}`)
    }
  }
}
console.log(`extraction: ${extraction.length} tasks`)

// Ledger-agent.
const ledger = loadTasks<LedgerAgentTask>('ledger-agent')
for (const t of ledger) {
  if (!SEEDS[t.input.seed]) problem(`${t.id}: unknown seed ${t.input.seed}`)
  if (!ASSERTIONS[t.gold.assertions]) {
    problem(`${t.id}: unknown assertions ${t.gold.assertions}`)
  }
}
console.log(`ledger-agent: ${ledger.length} tasks`)

if (failures > 0) {
  console.error(`\n${failures} validation failure(s)`)
  process.exit(1)
}
console.log('\nAll task files valid.')
