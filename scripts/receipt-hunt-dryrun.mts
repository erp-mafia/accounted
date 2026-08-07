/**
 * Provkörning of the receipt hunt against a real company.
 *
 *   npx tsx scripts/receipt-hunt-dryrun.mts <company_id>          # Underlag only
 *   npx tsx scripts/receipt-hunt-dryrun.mts <company_id> --mail   # also search mailboxes
 *
 * READ-ONLY. huntCompany runs with dryRun, which scores and reports but writes
 * nothing: no pending operations, and with --mail it lists what the mailbox
 * search found without downloading or storing any of it.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { huntCompany } from '@/lib/receipt-hunt/hunt'
import '@/lib/init'

const companyId = process.argv[2]
const withMail = process.argv.includes('--mail')
if (!companyId) throw new Error('usage: npx tsx scripts/receipt-hunt-dryrun.mts <company_id> [--mail]')

const env = new Map<string, string>()
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env.set(m[1], m[2].trim())
}
for (const [k, v] of env) if (!process.env[k]) process.env[k] = v

const url = env.get('NEXT_PUBLIC_SUPABASE_URL')
const key = env.get('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) throw new Error('missing Supabase credentials in .env.local')

const supabase = createClient(url, key, { auth: { persistSession: false } })
const result = await huntCompany(supabase, companyId, 'dryrun', { dryRun: true, searchMail: withMail })

console.log('\n=== PROVKÖRNING (inget skrivet) ===')
console.log(`obokförda köp utan kvitto : ${result.candidates}`)
console.log(`kvitton i Underlag        : ${result.poolSize}`)
console.log(`skulle föreslå            : ${result.proposed}\n`)

for (const p of result.proposals ?? []) {
  console.log(`  ${p.merchant_name ?? '(okänd)'}  ${p.total_amount} ${p.currency ?? ''}`)
  console.log(`    confidence ${p.confidence}  [${p.matchReasons.join(', ')}]`)
}
if ((result.proposals ?? []).length === 0) console.log('  (inga par ur Underlag nådde tröskeln)')

if (result.mail) {
  console.log(`\n=== BREVLÅDOR ===`)
  console.log(`köp genomsökta   : ${result.mail.searched}`)
  console.log(`underlag hittade : ${result.mail.withCandidates}`)
  console.log(`skulle hämta     : ${result.mail.candidates.length}\n`)
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
