/**
 * Move legacy individual customer personnummer values from org_number into
 * encrypted personal_number storage.
 *
 * Default mode is read-only. Production writes require Emil's explicit
 * approval for the specific run, followed by the --confirm flag.
 *
 * Usage:
 *   npx tsx scripts/repair-customer-personal-numbers.ts
 *   npx tsx scripts/repair-customer-personal-numbers.ts --confirm
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * PERSONNUMMER_ENCRYPTION_KEY from .env.local. Treat .env.local as production.
 * The script reports counts only and never prints a personnummer.
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'
import {
  encryptCustomerPersonalNumber,
  revealStoredCustomerPersonalNumber,
} from '@/lib/customers/protect-personal-number'
import { PERSONAL_NUMBER_PLAINTEXT_RE } from '@/lib/customers/mask-personal-number'
import { personalNumbersMatch } from '@/lib/customers/identifiers'

dotenv({ path: resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const confirm = process.argv.includes('--confirm')

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}
if (!process.env.PERSONNUMMER_ENCRYPTION_KEY) {
  console.error('Missing PERSONNUMMER_ENCRYPTION_KEY. Refusing to use the development fallback key.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
})

type Candidate = {
  id: string
  company_id: string
  org_number: string
  personal_number: string | null
}

type RepairPlan =
  | { kind: 'move'; row: Candidate }
  | { kind: 'clear_duplicate'; row: Candidate }
  | { kind: 'invalid'; row: Candidate }
  | { kind: 'conflict'; row: Candidate }
  | { kind: 'unreadable'; row: Candidate }

async function fetchCandidates(): Promise<Candidate[]> {
  const pageSize = 1000
  const rows: Candidate[] = []

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, company_id, org_number, personal_number')
      .eq('customer_type', 'individual')
      .not('org_number', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)

    if (error) throw new Error(`select customer repair candidates: ${error.message}`)
    const page = (data ?? []) as Candidate[]
    rows.push(...page)
    if (page.length < pageSize) return rows
  }
}

function planRepair(row: Candidate): RepairPlan {
  if (!PERSONAL_NUMBER_PLAINTEXT_RE.test(row.org_number)) {
    return { kind: 'invalid', row }
  }
  if (!row.personal_number) {
    return { kind: 'move', row }
  }

  try {
    const stored = revealStoredCustomerPersonalNumber(row.personal_number)
    if (stored && personalNumbersMatch(stored, row.org_number)) {
      return { kind: 'clear_duplicate', row }
    }
    return { kind: 'conflict', row }
  } catch {
    return { kind: 'unreadable', row }
  }
}

async function applyRepair(plan: RepairPlan): Promise<boolean> {
  if (plan.kind !== 'move' && plan.kind !== 'clear_duplicate') return false

  let query =
    plan.kind === 'move'
      ? supabase.from('customers').update({
          org_number: null,
          personal_number: encryptCustomerPersonalNumber(plan.row.org_number),
        })
      : supabase.from('customers').update({ org_number: null })

  query = query
    .eq('id', plan.row.id)
    .eq('company_id', plan.row.company_id)
    .eq('customer_type', 'individual')
    .eq('org_number', plan.row.org_number)

  query = plan.row.personal_number
    ? query.eq('personal_number', plan.row.personal_number)
    : query.is('personal_number', null)

  const { data, error } = await query.select('id').maybeSingle()
  if (error) throw new Error(`update customer ${plan.row.id}: ${error.message}`)
  return Boolean(data)
}

async function main() {
  const host = new URL(supabaseUrl!).host
  console.log(`Target: ${host}`)
  console.log(`Mode: ${confirm ? 'WRITE (--confirm)' : 'DRY RUN (read-only)'}`)

  const candidates = await fetchCandidates()
  const plans = candidates.map(planRepair)
  const counts = {
    candidates: plans.length,
    move: plans.filter((plan) => plan.kind === 'move').length,
    clear_duplicate: plans.filter((plan) => plan.kind === 'clear_duplicate').length,
    invalid: plans.filter((plan) => plan.kind === 'invalid').length,
    conflict: plans.filter((plan) => plan.kind === 'conflict').length,
    unreadable: plans.filter((plan) => plan.kind === 'unreadable').length,
  }

  console.log(JSON.stringify(counts, null, 2))
  if (!confirm) {
    console.log('No writes performed. Review the counts before requesting production approval.')
    return
  }

  let updated = 0
  let concurrentlyChanged = 0
  for (const plan of plans) {
    if (plan.kind !== 'move' && plan.kind !== 'clear_duplicate') continue
    if (await applyRepair(plan)) updated++
    else concurrentlyChanged++
  }

  console.log(JSON.stringify({ updated, concurrently_changed: concurrentlyChanged }, null, 2))
  console.log('Run again without --confirm and verify move and clear_duplicate are both zero.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
