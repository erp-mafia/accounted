/**
 * Provkörning of the receipt hunt against a real company.
 *
 *   npx tsx scripts/receipt-hunt-dryrun.mts <company_id>                 # Underlag only
 *   npx tsx scripts/receipt-hunt-dryrun.mts <company_id> --mail          # also search mailboxes
 *   npx tsx scripts/receipt-hunt-dryrun.mts <company_id> --mail --live   # actually fetch and stage
 *
 * Without --live nothing is written: the hunt scores and reports, and with
 * --mail it lists what the mailboxes hold without copying any of it.
 *
 * Everything is imported dynamically, after .env.local is read into
 * process.env. Static imports are hoisted and would run before the environment
 * exists, which makes the Supabase client fail inside the extension that
 * extracts uploaded documents: the failure is silent apart from one event-bus
 * error, and it leaves every fetched receipt without an amount.
 */
import { readFileSync } from 'node:fs'

const companyId = process.argv[2]
const withMail = process.argv.includes('--mail')
const live = process.argv.includes('--live')
// --sweep searches every candidate purchase instead of the nightly top slice.
// For a company with a backlog the first run is a backfill, not a nightly tick.
const sweep = process.argv.includes('--sweep')
if (!companyId) throw new Error('usage: npx tsx scripts/receipt-hunt-dryrun.mts <company_id> [--mail] [--live]')

const env = new Map<string, string>()
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env.set(m[1], m[2].trim())
}
for (const [k, v] of env) if (!process.env[k]) process.env[k] = v

const url = env.get('NEXT_PUBLIC_SUPABASE_URL')
const key = env.get('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) throw new Error('missing Supabase credentials in .env.local')

// --live writes to whatever database .env.local points at, which for this repo
// is production. Requiring the company id to be named again is the cheapest
// guard that a stray --live on a recalled command cannot pass.
if (live && process.env.RECEIPT_HUNT_CONFIRM !== companyId) {
  throw new Error(
    `--live writes documents and proposals to the database in .env.local.\n` +
      `Re-run with RECEIPT_HUNT_CONFIRM=${companyId} to confirm.`,
  )
}

const { createClient } = await import('@supabase/supabase-js')
// Wiring the event bus is what lets document.uploaded reach the extraction
// extension. Importing lib/init is not enough; it has to be called.
const { ensureInitialized } = await import('@/lib/init')
ensureInitialized()
const { huntCompany } = await import('@/lib/receipt-hunt/hunt')

const supabase = createClient(url, key, { auth: { persistSession: false } })
const result = await huntCompany(supabase, companyId, live ? `live-${Date.now()}` : 'dryrun', {
  dryRun: !live,
  searchMail: withMail,
  ...(sweep ? { mailSearchLimit: 500 } : {}),
})

if (live) {
  console.log(`\n*** SKARP KÖRNING: ${result.mail?.ingested ?? 0} underlag hämtade, ${result.proposed} förslag lagda ***`)
}

console.log(`\n=== ${live ? 'KÖRNING' : 'PROVKÖRNING (inget skrivet)'} ===`)
console.log(`obokförda köp utan kvitto : ${result.candidates}`)
console.log(`kvitton i Underlag        : ${result.poolSize}`)
console.log(`förslag                   : ${result.proposed}\n`)

for (const p of result.proposals ?? []) {
  console.log(`  ${p.merchant_name ?? '(okänd)'}  ${p.total_amount} ${p.currency ?? ''}`)
  console.log(`    confidence ${p.confidence}  [${p.matchReasons.join(', ')}]`)
}

if (result.mail) {
  console.log(`\n=== BREVLÅDOR ===`)
  console.log(`köp genomsökta   : ${result.mail.searched}`)
  console.log(`underlag hittade : ${result.mail.withCandidates}`)
  console.log(`hämtade          : ${result.mail.ingested}\n`)
  for (const c of result.mail.candidates) {
    console.log(`  [${c.merchant}] ${c.fileName ?? '(bilaga)'}`)
    console.log(`    ur ${c.mailbox}: "${c.subject ?? '(utan ämne)'}" från ${c.from ?? '?'}`)
    console.log(`    ${c.reason}`)
  }
  if (result.mail.candidates.length === 0) console.log('  (inga underlag hittade)')
} else if (withMail) {
  console.log('\n(ingen brevlåda kopplad, eller Gmail inte konfigurerat)')
}
console.log('')
