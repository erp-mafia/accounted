#!/usr/bin/env npx tsx
/**
 * One-off repair: move an individual customer's personnummer out of
 * customers.org_number into customers.personal_number (encrypted), and clear
 * org_number on every individual.
 *
 * WHY: a privatperson has no org number, and its personnummer belongs
 * encrypted in personal_number. Until the write paths all enforced that
 * (the MCP create tool before 2026-08-21, the CSV register import until
 * fix/customer-import-personnummer), an individual's personnummer could land
 * in plaintext in org_number. The code fix stops new rows; this repairs the
 * rows already there, and must run before the customers_individual_no_org_number
 * check is added (that migration refuses any UPDATE of a row it would reject).
 *
 * Per row (customer_type='individual' with a non-blank org_number), decided by
 * scripts/lib/customer-org-number-repair.ts:
 *   move                      personal_number empty: encrypt org_number into it, clear org_number
 *   clear_same                personal_number holds the same personnummer: clear org_number
 *   clear_differ              personal_number holds a different one: the stored one wins, clear org_number
 *   skip_unreadable           stored personal_number cannot be decrypted: left alone
 *   skip_not_personal_number  org_number is not a personnummer: left alone for a manual decision
 *
 * Dry run by default: reads, decides and prints counts, writes nothing.
 *
 *   npx tsx scripts/repair-customer-personal-number-in-org-number.ts --env <file>
 *   npx tsx scripts/repair-customer-personal-number-in-org-number.ts --env <file> --apply
 *   add --company <uuid> to limit either mode to one company
 *
 * --env names the environment file explicitly (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, PERSONNUMMER_ENCRYPTION_KEY); .env.local is
 * refused so the target is never implicit. The key is needed in both modes:
 * the dry run decrypts stored personal_number values to tell same from
 * differ, and the apply encrypts with it.
 *
 * Output is counts only: no personnummer, ciphertext, customer id or company
 * id is ever printed. Every write is guarded on the exact values the decision
 * was made on, so a concurrent edit or a re-run never double-applies; a row
 * that changed underneath is counted as skipped. Safe to re-run.
 *
 * Never run by a loop: the founder decides when it runs.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  encryptCustomerPersonalNumber,
  revealStoredCustomerPersonalNumber,
} from '@/lib/customers/protect-personal-number'
import { normalizeReroutedPersonalNumber } from '@/lib/customers/personal-number-shape'
import {
  countOrgNumberRepairActions,
  isWritingAction,
  planOrgNumberRepair,
  type OrgNumberRepairAction,
} from './lib/customer-org-number-repair'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const ENV_FILE = arg('env')
if (!ENV_FILE || ENV_FILE.split(/[\\/]/).at(-1) === '.env.local') {
  console.error('--env must name an explicit repair environment file; .env.local is not a repair target')
  process.exit(1)
}
const loadedEnv = config({ path: ENV_FILE, override: true, quiet: true })
if (loadedEnv.error) {
  console.error(`Cannot read repair environment file: ${ENV_FILE}`)
  process.exit(1)
}

const APPLY = process.argv.includes('--apply')
const COMPANY_ID = arg('company') ?? null
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (COMPANY_ID !== null && !UUID_RE.test(COMPANY_ID)) {
  console.error('--company must be a uuid')
  process.exit(1)
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}`)
  process.exit(1)
}
// Without the real key the dry run would call every stored value
// undecryptable, and the apply would encrypt with the dev fallback key and
// make the moved values unreadable in production.
if (!process.env.PERSONNUMMER_ENCRYPTION_KEY) {
  console.error(`Missing PERSONNUMMER_ENCRYPTION_KEY in ${ENV_FILE}; it is needed to compare and to encrypt.`)
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Row = {
  id: string
  company_id: string
  customer_type: string
  org_number: string
  personal_number: string | null
}

async function main(): Promise<void> {
  console.log(
    `Target: ${new URL(supabaseUrl!).host} (${ENV_FILE})   mode: ${APPLY ? 'APPLY' : 'DRY RUN (read-only)'}`
    + (COMPANY_ID ? '   scope: one company' : '   scope: all companies'),
  )

  const rows = await fetchAllRows<Row>(({ from, to }) => {
    let query = supabase
      .from('customers')
      .select('id, company_id, customer_type, org_number, personal_number')
      .eq('customer_type', 'individual')
      .not('org_number', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
    if (COMPANY_ID) query = query.eq('company_id', COMPANY_ID)
    return query
  })

  const planned: { row: Row; action: OrgNumberRepairAction }[] = []
  for (const row of rows) {
    const action = planOrgNumberRepair(row, (stored) => revealStoredCustomerPersonalNumber(stored) ?? '')
    if (action) planned.push({ row, action })
  }

  const counts = countOrgNumberRepairActions(planned.map((p) => p.action))
  const companies = new Set(planned.map((p) => p.row.company_id)).size
  console.log(`Individuals with a non-blank org_number: ${planned.length}, in ${companies} companies.`)
  for (const [action, count] of Object.entries(counts)) console.log(`  ${action.padEnd(26)} ${count}`)

  if (!APPLY) {
    console.log('Dry run: nothing written. Re-run with --apply to write.')
    return
  }

  let written = 0
  let changedUnderneath = 0
  const failures = new Map<string, number>()
  for (const { row, action } of planned) {
    if (!isWritingAction(action)) continue
    // Guarded on the values the decision was made on. Two literal payloads
    // so the no-phantom-columns scanner can resolve both.
    const result = action === 'move'
      ? await supabase
          .from('customers')
          .update({
            org_number: null,
            personal_number: encryptCustomerPersonalNumber(normalizeReroutedPersonalNumber(row.org_number)),
          })
          .eq('id', row.id)
          .eq('company_id', row.company_id)
          .eq('customer_type', 'individual')
          .eq('org_number', row.org_number)
          .is('personal_number', null)
          .select('id')
      : await supabase
          .from('customers')
          .update({ org_number: null })
          .eq('id', row.id)
          .eq('company_id', row.company_id)
          .eq('customer_type', 'individual')
          .eq('org_number', row.org_number)
          .eq('personal_number', row.personal_number!)
          .select('id')
    if (result.error) {
      // The code only: a message or detail could quote the row.
      const code = result.error.code || 'unknown'
      failures.set(code, (failures.get(code) ?? 0) + 1)
    } else if (!result.data || result.data.length === 0) {
      changedUnderneath += 1
    } else {
      written += 1
    }
  }

  console.log(`Done. written: ${written}, changed underneath (skipped): ${changedUnderneath}, failed: ${[...failures.values()].reduce((a, b) => a + b, 0)}`)
  for (const [code, count] of failures) console.log(`  failed with ${code}: ${count}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
