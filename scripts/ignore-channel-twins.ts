#!/usr/bin/env -S npx tsx --conditions react-server
/**
 * Set aside the bank rows of one account that duplicate another channel's
 * rows of the same movements, for an account a ledger move merged before
 * the move planned its copies itself (crm#1701). The rule and the write are
 * planTwins and applyTwins (lib/transactions/channel-twins.ts), the same the
 * move runs. Nothing is deleted and no verifikat is touched: rows are
 * ignored, and restore undoes it.
 *
 * The move compares the two accounts while they are still apart. Here they
 * are already one, so the operator names the two channels that met only
 * through the merge (the statement files' import_source and the bank feed's),
 * having checked that no import compared them (they sat on two accounts).
 *
 * Dry run by default:
 *
 *   npx tsx --conditions react-server scripts/ignore-channel-twins.ts --env <file> \
 *     --company <uuid> --cash-account <uuid> --side-a csv_seb --side-b open_payments
 *
 * A write names the person who decided it and a stable operation id, recorded
 * on the BankTransactionTwinsIgnored behandlingshistorik event:
 *
 *   ... --actor-user-id <uuid> --operation-id <uuid> --execute
 *
 * Never run by a loop: the founder decides per account.
 */

import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { applyTwins, planTwins, readAccountRows } from '@/lib/transactions/channel-twins'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ENV_FILE = arg('env')
if (!ENV_FILE || ENV_FILE.split(/[\\/]/).at(-1) === '.env.local') {
  console.error('--env must name an explicit repair environment file; .env.local is not a repair target')
  process.exit(1)
}
if (config({ path: ENV_FILE, override: true, quiet: true }).error) {
  console.error(`Cannot read repair environment file: ${ENV_FILE}`)
  process.exit(1)
}

const COMPANY_ID = arg('company')
const CASH_ACCOUNT_ID = arg('cash-account')
const SIDE_A = arg('side-a')
const SIDE_B = arg('side-b')
const ACTOR_USER_ID = arg('actor-user-id')
const OPERATION_ID = arg('operation-id')
const EXECUTE = process.argv.includes('--execute')

if (!COMPANY_ID || !UUID.test(COMPANY_ID) || !CASH_ACCOUNT_ID || !UUID.test(CASH_ACCOUNT_ID)) {
  console.error('--company and --cash-account must be uuids')
  process.exit(1)
}
if (!SIDE_A || !SIDE_B || SIDE_A === SIDE_B) {
  console.error('--side-a and --side-b must name two different import sources, e.g. csv_seb and open_payments')
  process.exit(1)
}
if (EXECUTE && (!ACTOR_USER_ID || !UUID.test(ACTOR_USER_ID) || !OPERATION_ID || !UUID.test(OPERATION_ID))) {
  console.error('--execute needs --actor-user-id and --operation-id (uuids)')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}`)
  process.exit(1)
}
const supabase = createClient(url, key, { auth: { persistSession: false } })

async function main(): Promise<void> {
  console.log(`Target ${new URL(url!).host}, company ${COMPANY_ID}, account ${CASH_ACCOUNT_ID}, ${SIDE_A} vs ${SIDE_B}, ${EXECUTE ? 'WRITE' : 'dry run'}`)
  const rows = await readAccountRows(supabase, COMPANY_ID!, [CASH_ACCOUNT_ID!])
  const plan = planTwins(
    rows.filter((r) => r.import_source === SIDE_A),
    rows.filter((r) => r.import_source === SIDE_B),
  )
  console.log(`Rows read: ${rows.length}; open copies planned: ${plan.setAside.length}; days booked more times than they have movements: ${plan.overBookedBuckets}`)
  for (const s of plan.setAside.slice(0, 10)) console.log(`  ${s.transaction_id} duplicates ${s.twin_transaction_id}`)
  if (plan.setAside.length > 10) console.log(`  ... and ${plan.setAside.length - 10} more`)
  if (!EXECUTE) return
  const done = await applyTwins(supabase, COMPANY_ID!, plan, {
    actor: { type: 'user', id: ACTOR_USER_ID! },
    correlationId: OPERATION_ID!,
    reason: 'repair',
    historyClient: supabase,
  })
  console.log(`Set aside: ${done.length}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
