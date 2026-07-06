/**
 * Delete orphan [SKV-TEST] journal entries from a company.
 *
 * Use this to recover from a failed seed-skv-test-data.ts run that inserted
 * draft entries but failed to commit them (e.g., constraint violation).
 *
 * Usage: npx tsx scripts/clean-skv-test-drafts.ts <COMPANY_ID>
 */

import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const companyId = process.argv[2]
if (!companyId) {
  console.error('Usage: npx tsx scripts/clean-skv-test-drafts.ts <COMPANY_ID>')
  process.exit(1)
}

async function main() {
  // Find every [SKV-TEST] entry on this company.
  const { data: entries, error: fetchErr } = await supabase
    .from('journal_entries')
    .select('id, status, description, voucher_number')
    .eq('company_id', companyId)
    .like('description', '[SKV-TEST]%')
  if (fetchErr) throw new Error(`fetch: ${fetchErr.message}`)

  if (!entries || entries.length === 0) {
    console.log('No [SKV-TEST] entries found.')
    return
  }

  console.log(`Found ${entries.length} [SKV-TEST] entries:`)
  for (const e of entries) {
    console.log(`  ${e.status.padEnd(10)} A${e.voucher_number ?? '?'}  ${e.description}`)
  }

  // journal_entry_lines cascades on journal_entries delete, but we still need
  // to handle the immutability trigger for status='posted'. Drafts only.
  const drafts = entries.filter(e => e.status === 'draft')
  const posted = entries.filter(e => e.status !== 'draft')

  if (posted.length > 0) {
    console.log(`\n⚠ ${posted.length} entries are status='posted' or 'reversed': those are immutable per BFL.`)
    console.log('  If you really want to remove them, you have to reverse them first or hard-delete via psql with triggers disabled.')
    console.log('  Skipping those here.')
  }

  if (drafts.length === 0) {
    console.log('\nNo draft entries to delete.')
    return
  }

  // BFL compliance trigger blocks DELETE on journal_entries: soft-delete via
  // status='cancelled' instead. Cancelled entries are filtered out by the VAT
  // calculator (which only reads 'posted' and 'reversed').
  console.log(`\nMarking ${drafts.length} draft entries as cancelled...`)
  const ids = drafts.map(d => d.id)
  const { error: cancelErr } = await supabase
    .from('journal_entries')
    .update({ status: 'cancelled' })
    .in('id', ids)
  if (cancelErr) throw new Error(`cancel update: ${cancelErr.message}`)
  console.log(`  ✓ ${drafts.length} drafts cancelled.`)
}

main().catch(err => { console.error(err); process.exit(1) })
