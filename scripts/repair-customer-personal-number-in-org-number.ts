/**
 * One-off repair: move an individual customer's personnummer out of
 * customers.org_number into customers.personal_number (encrypted).
 *
 * WHY: until 2026-08-21 the MCP gnubok_create_customer tool had no
 * personal_number input, the v1 REST docs said org_number was "accepted as
 * input" for individuals, and nothing masks org_number. So a customer_type=
 * 'individual' row could carry its personnummer in org_number, where the
 * web customer list, the v1 detail endpoint and the MCP customer list showed
 * it raw (GDPR art. 5.1 c). The code fix moves such a value into
 * personal_number on every write path; this repairs the rows already in the
 * DB. Run AFTER the code fix is deployed (the read paths mask these rows in
 * the meantime, but the data should not stay there).
 *
 * Selection: customer_type='individual' AND org_number has Swedish personnummer
 * shape (lib/customers/personal-number-shape.ts). Legal-entity org numbers
 * never match (month position >= 20), so an individual carrying a real
 * organisationsnummer is left alone.
 *
 * Per row:
 *   - personal_number NULL       -> personal_number = encrypt(org_number), org_number = NULL
 *   - personal_number already set -> org_number = NULL only (the stored
 *                                    personnummer wins; the duplicate is reported)
 *
 * Idempotent: a repaired row no longer matches the selection, and every
 * update is guarded on the exact org_number value so a re-run or a concurrent
 * edit can never double-apply. Safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/repair-customer-personal-number-in-org-number.ts            # dry run (read-only)
 *   npx tsx scripts/repair-customer-personal-number-in-org-number.ts --confirm  # performs the writes
 *   add --company <uuid> to limit either mode to one company
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local;
 * --confirm additionally needs PERSONNUMMER_ENCRYPTION_KEY (the production
 * key, same one the app encrypts with). Treat .env.local as pointing at
 * PRODUCTION: the dry run is read-only; --confirm mutates PII. Never prints a
 * personnummer; rows are reported by id and company.
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'
import { encryptCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import {
  normalizeReroutedPersonalNumber,
  orgNumberHoldsPersonalNumber,
} from '@/lib/customers/personal-number-shape'

dotenv({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const CONFIRM = process.argv.includes('--confirm')
// Refuse to WRITE without the real key: encrypting with the dev fallback key
// would make the values unreadable in production. The dry run encrypts
// nothing, so it runs without it (the key lives in the Vercel env, not in
// every local .env.local).
if (CONFIRM && !process.env.PERSONNUMMER_ENCRYPTION_KEY) {
  console.error(
    'Missing PERSONNUMMER_ENCRYPTION_KEY. Refusing to write so rows are not encrypted with the dev fallback key '
    + '(vercel env pull, or set it for this run).',
  )
  process.exit(1)
}
const companyFlag = process.argv.indexOf('--company')
const ONLY_COMPANY = companyFlag >= 0 ? process.argv[companyFlag + 1] : undefined

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

type Row = {
  id: string
  company_id: string
  customer_type: string
  org_number: string | null
  personal_number: string | null
}

async function main() {
  const host = new URL(SUPABASE_URL!).host
  console.log(
    `Target: ${host}   mode: ${CONFIRM ? 'WRITE (--confirm)' : 'DRY RUN (read-only)'}`
    + (ONLY_COMPANY ? `   company: ${ONLY_COMPANY}` : ''),
  )

  // Page on the PK: PostgREST caps an unranged select at 1000 rows.
  const PAGE = 1000
  const candidates: Row[] = []
  for (let from = 0; ; from += PAGE) {
    let query = sb
      .from('customers')
      .select('id, company_id, customer_type, org_number, personal_number')
      .eq('customer_type', 'individual')
      .not('org_number', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (ONLY_COMPANY) query = query.eq('company_id', ONLY_COMPANY)
    const { data, error } = await query
    if (error) throw new Error(`select customers: ${error.message}`)
    const rows = (data ?? []) as Row[]
    candidates.push(...rows)
    if (rows.length < PAGE) break
  }

  const affected = candidates.filter((r) => orgNumberHoldsPersonalNumber(r.customer_type, r.org_number))
  const toMove = affected.filter((r) => !r.personal_number)
  const toClear = affected.filter((r) => r.personal_number)
  const companies = new Set(affected.map((r) => r.company_id))

  console.log(
    `Individual rows with org_number: ${candidates.length}; personnummer-shaped: ${affected.length} `
    + `across ${companies.size} companies (move: ${toMove.length}, clear-duplicate: ${toClear.length}).`,
  )
  for (const r of affected) {
    console.log(`  ${r.personal_number ? 'CLEAR' : 'MOVE '}  customer ${r.id}  company ${r.company_id}`)
  }

  if (!CONFIRM) {
    console.log('Dry run: no writes performed. Re-run with --confirm to apply.')
    return
  }

  let moved = 0
  let cleared = 0
  let skipped = 0
  for (const r of affected) {
    // Guard on the exact current value: a concurrent edit or a re-run cannot
    // double-apply, and a row that changed underneath is skipped, not clobbered.
    // Two literal payloads rather than one built at runtime, so the
    // no-phantom-columns scanner can resolve both.
    const { data, error } = r.personal_number
      ? await sb
          .from('customers')
          .update({ org_number: null })
          .eq('id', r.id)
          .eq('company_id', r.company_id)
          .eq('org_number', r.org_number!)
          .select('id')
      : await sb
          .from('customers')
          .update({
            org_number: null,
            personal_number: encryptCustomerPersonalNumber(normalizeReroutedPersonalNumber(r.org_number!)),
          })
          .eq('id', r.id)
          .eq('company_id', r.company_id)
          .eq('org_number', r.org_number!)
          .select('id')
    if (error) {
      console.error(`  FAILED customer ${r.id}: ${error.message}`)
      continue
    }
    if (!data || data.length === 0) {
      skipped += 1
      continue
    }
    if (r.personal_number) cleared += 1
    else moved += 1
  }
  console.log(`Done. moved: ${moved}, cleared duplicate org_number: ${cleared}, skipped (changed underneath): ${skipped}.`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
