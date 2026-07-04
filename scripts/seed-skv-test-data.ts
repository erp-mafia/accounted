/**
 * Seed VAT test data for Skatteverket momsdeklaration kontrollera testing.
 *
 * Creates a fiscal period (if missing) and a set of balanced posted journal
 * entries that exercise every Ruta the calculator populates. After running
 * this you can call /api/extensions/ext/skatteverket/declaration/validate
 * for the same period and Skatteverket should return a non-empty
 * kontrollresultat covering the full SKV 4700 form.
 *
 * Usage:
 *   npx tsx scripts/seed-skv-test-data.ts <COMPANY_ID> <YEAR> <MONTH>
 *
 * Example:
 *   npx tsx scripts/seed-skv-test-data.ts 11111111-aaaa-bbbb-cccc-222222222222 2026 3
 *
 * Idempotency: every entry's description is prefixed `[SKV-TEST]` so reruns
 * are easy to identify and clean up:
 *   delete from journal_entries
 *     where company_id = '<id>' and description like '[SKV-TEST]%';
 *
 * Requires: SUPABASE_SERVICE_ROLE_KEY in .env.local (already set if you've
 * been running the dev server).
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

interface Line {
  account: string
  debit?: number
  credit?: number
  description?: string
}

interface Scenario {
  description: string
  lines: Line[]
  expectedRutor: string
}

const [, , companyIdArg, yearArg, monthArg] = process.argv

if (!companyIdArg || !yearArg || !monthArg) {
  console.error('Usage: npx tsx scripts/seed-skv-test-data.ts <COMPANY_ID> <YEAR> <MONTH>')
  process.exit(1)
}

const companyId = companyIdArg
const year = Number(yearArg)
const month = Number(monthArg)
const entryDate = `${year}-${String(month).padStart(2, '0')}-15`

// Scenarios chosen to populate every Ruta the calculator now reads from the
// ledger. Each one balances debits = credits.
const scenarios: Scenario[] = [
  {
    description: 'Domestic invoice, 25% rate (Acme Konsult AB)',
    expectedRutor: 'Ruta 05 + 10',
    lines: [
      { account: '1510', debit: 12500, description: 'Kundfordran' },
      { account: '3001', credit: 10000, description: 'Försäljning 25%' },
      { account: '2611', credit: 2500, description: 'Utgående moms 25%' },
    ],
  },
  {
    description: 'Domestic invoice, 12% rate (restaurang)',
    expectedRutor: 'Ruta 05 + 11',
    lines: [
      { account: '1510', debit: 11200 },
      { account: '3002', credit: 10000, description: 'Försäljning 12%' },
      { account: '2621', credit: 1200, description: 'Utgående moms 12%' },
    ],
  },
  {
    description: 'Domestic invoice, 6% rate (transport)',
    expectedRutor: 'Ruta 05 + 12',
    lines: [
      { account: '1510', debit: 10600 },
      { account: '3003', credit: 10000, description: 'Försäljning 6%' },
      { account: '2631', credit: 600, description: 'Utgående moms 6%' },
    ],
  },
  {
    description: 'EU services purchase (German consulting)',
    expectedRutor: 'Ruta 21 + 30 + 48',
    lines: [
      { account: '4535', debit: 5000, description: 'Inköp tjänster EU 25%' },
      { account: '2645', debit: 1250, description: 'Beräknad ingående moms' },
      { account: '2614', credit: 1250, description: 'Utgående moms omv. skattskyldighet' },
      { account: '2440', credit: 5000, description: 'Leverantörsskuld' },
    ],
  },
  {
    description: 'Non-EU services purchase (Anthropic)',
    expectedRutor: 'Ruta 22 + 30 + 48',
    lines: [
      { account: '4531', debit: 3000, description: 'Inköp tjänster utanför EU' },
      { account: '2645', debit: 750 },
      { account: '2614', credit: 750 },
      { account: '2440', credit: 3000 },
    ],
  },
  {
    description: 'Domestic mobile reverse charge (electronics >100k)',
    expectedRutor: 'Ruta 23 + 30 + 48',
    lines: [
      { account: '4415', debit: 100000, description: 'Inköp mobiler omv. skattskyldighet' },
      { account: '2647', debit: 25000, description: 'Ingående moms omv. skattskyldighet i SE' },
      { account: '2614', credit: 25000 },
      { account: '2440', credit: 100000 },
    ],
  },
  {
    description: 'Domestic services reverse charge (byggtjänst)',
    expectedRutor: 'Ruta 24 + 30 + 48',
    lines: [
      { account: '4425', debit: 8000, description: 'Inköp byggtjänster omv.' },
      { account: '2647', debit: 2000 },
      { account: '2614', credit: 2000 },
      { account: '2440', credit: 8000 },
    ],
  },
  {
    description: 'EU goods sale (intra-community supply, zero-rated)',
    expectedRutor: 'Ruta 35',
    lines: [
      { account: '1510', debit: 4000 },
      { account: '3108', credit: 4000, description: 'Varuförsäljning till EU' },
    ],
  },
  {
    description: 'Export sale (non-EU)',
    expectedRutor: 'Ruta 36',
    lines: [
      { account: '1510', debit: 5000 },
      { account: '3105', credit: 5000, description: 'Varuförsäljning export' },
    ],
  },
  {
    description: 'EU services sale (B2B, buyer self-assesses)',
    expectedRutor: 'Ruta 39',
    lines: [
      { account: '1510', debit: 8000 },
      { account: '3308', credit: 8000, description: 'Tjänsteförsäljning till EU' },
    ],
  },
  {
    description: 'Office supplies purchase (regular input VAT)',
    expectedRutor: 'Ruta 48',
    lines: [
      { account: '5410', debit: 800, description: 'Förbrukningsinventarier' },
      { account: '2641', debit: 200, description: 'Ingående moms 25%' },
      { account: '2440', credit: 1000 },
    ],
  },
  {
    description: 'Import from non-EU (paid via Tullverket, VAT to SKV)',
    expectedRutor: 'Ruta 50 + 60 + 48',
    lines: [
      { account: '4545', debit: 10000, description: 'Beskattningsunderlag import 25%' },
      { account: '2641', debit: 2500, description: 'Ingående moms import' },
      { account: '2615', credit: 2500, description: 'Utgående moms import 25%' },
      { account: '2440', credit: 10000 },
    ],
  },
  {
    description: 'Owner uttag in kind (only for EF): comment out if AB',
    expectedRutor: 'Ruta 06 + 10',
    lines: [
      { account: '2013', debit: 1250, description: 'Egna uttag' },
      { account: '3401', credit: 1000, description: 'Uttag 25%' },
      { account: '2612', credit: 250, description: 'Utgående moms uttag 25%' },
    ],
  },
]

async function ensureFiscalPeriod(): Promise<{ id: string; userId: string }> {
  const periodStart = `${year}-01-01`
  const periodEnd = `${year}-12-31`

  // Reuse if it exists
  const { data: existing, error: fetchErr } = await supabase
    .from('fiscal_periods')
    .select('id, user_id')
    .eq('company_id', companyId)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .maybeSingle()

  if (fetchErr) throw new Error(`fiscal_periods select: ${fetchErr.message}`)
  if (existing) return { id: existing.id, userId: existing.user_id }

  const { data: ownerRow, error: ownerErr } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'owner')
    .limit(1)
    .single()
  if (ownerErr || !ownerRow) {
    throw new Error(`No owner found for company ${companyId}: ${ownerErr?.message}`)
  }
  const userId = ownerRow.user_id

  const { data: created, error: insertErr } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      user_id: userId,
      name: `${year} (SKV test)`,
      period_start: periodStart,
      period_end: periodEnd,
    })
    .select('id, user_id')
    .single()

  if (insertErr || !created) throw new Error(`fiscal_periods insert: ${insertErr?.message}`)
  console.log(`Created fiscal period ${created.id} (${periodStart} → ${periodEnd})`)
  return { id: created.id, userId: created.user_id }
}

async function seedScenario(
  scenario: Scenario,
  fiscalPeriodId: string,
  userId: string,
): Promise<void> {
  const { description, lines } = scenario
  const debit = lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  const credit = lines.reduce((s, l) => s + (l.credit ?? 0), 0)
  if (Math.abs(debit - credit) > 0.005) {
    throw new Error(`Scenario unbalanced: ${description} (D=${debit}, C=${credit})`)
  }

  // 1. Insert draft entry
  const { data: draft, error: draftErr } = await supabase
    .from('journal_entries')
    .insert({
      company_id: companyId,
      user_id: userId,
      fiscal_period_id: fiscalPeriodId,
      voucher_number: 0, // placeholder; commit_journal_entry assigns the real one
      voucher_series: 'A',
      entry_date: entryDate,
      description: `[SKV-TEST] ${description}`,
      source_type: 'manual',
      status: 'draft',
    })
    .select('id')
    .single()

  if (draftErr || !draft) throw new Error(`draft insert (${description}): ${draftErr?.message}`)

  // 2. Insert lines
  const lineRows = lines.map((l, idx) => ({
    journal_entry_id: draft.id,
    account_number: l.account,
    debit_amount: l.debit ?? 0,
    credit_amount: l.credit ?? 0,
    line_description: l.description ?? null,
    sort_order: idx,
  }))
  const { error: linesErr } = await supabase.from('journal_entry_lines').insert(lineRows)
  if (linesErr) throw new Error(`lines insert (${description}): ${linesErr.message}`)

  // 3. Commit via RPC (assigns sequential voucher number, sets status='posted').
  // commit_method enum: 'user_accept' | 'bulk_accept' | 'timing_ceiling' |
  // 'migration' | 'legacy'. 'migration' is the closest fit for synthetic test
  // data inserted outside the normal user-accept flow.
  const { data: voucherRow, error: commitErr } = await supabase.rpc('commit_journal_entry', {
    p_company_id: companyId,
    p_entry_id: draft.id,
    p_commit_method: 'migration',
    p_rubric_version: null,
  })
  if (commitErr) throw new Error(`commit (${description}): ${commitErr.message}`)
  const voucherNumber = Array.isArray(voucherRow) ? voucherRow[0]?.voucher_number : voucherRow?.voucher_number
  console.log(`  ✓ A${voucherNumber} ${description.padEnd(60)} → ${scenario.expectedRutor}`)
}

async function main() {
  console.log(`Seeding SKV test data for company ${companyId}, period ${year}-${String(month).padStart(2, '0')}`)
  const { id: fiscalPeriodId, userId } = await ensureFiscalPeriod()

  for (const scenario of scenarios) {
    try {
      await seedScenario(scenario, fiscalPeriodId, userId)
    } catch (err) {
      console.error(`  ✗ ${scenario.description}: ${(err as Error).message}`)
    }
  }

  console.log('\nDone. Verify in /reports → Momsdeklaration:')
  console.log(`  • Period: ${year}-${String(month).padStart(2, '0')}`)
  console.log('  • Expected non-zero Rutor: 05, 06, 10, 11, 12, 21, 22, 23, 24, 30, 35, 36, 39, 48, 50, 60')
  console.log('\nClean up later with:')
  console.log(`  delete from journal_entry_lines where journal_entry_id in (select id from journal_entries where company_id = '${companyId}' and description like '[SKV-TEST]%');`)
  console.log(`  delete from journal_entries where company_id = '${companyId}' and description like '[SKV-TEST]%';`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
