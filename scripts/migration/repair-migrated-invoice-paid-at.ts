#!/usr/bin/env npx tsx
/**
 * Support one-shot: repair the fabricated payment date on migrated customer
 * invoices (#2798 part C).
 *
 * WHY: until #2769 (merged 2026-09-20) the migration wrote
 * `paid_at = invoice_date` on every paid invoice whose provider named no
 * settlement date, which is every Fortnox, Bokio, Briox and Bjorn Lunden
 * invoice. New migrations write null; the rows already written stay wrong
 * until this runs. The in-app route (POST /reconcile with
 * `repairInvoicePaidAt: true`) does the same for a member of the company;
 * this script does it for support, who is not a member, with the
 * service-role key.
 *
 * WHAT IT DOES: reads the paid invoices of ONE company that carry the
 * mapper's signature (paid_at = the invoice date at exactly 00:00 UTC, row
 * created before #2769). For each it writes, in this order of preference, the
 * entry_date of the one posted journal entry its invoice_payments rows point
 * at, or null when nothing names a date AND the company's provider never
 * supplied one. Visma and WINT rows with no source are left alone: their
 * mapper reads a real settlement date, so the stored value may be true.
 * The rules and the reasoning live in
 * extensions/general/arcim-migration/lib/repair-migrated-invoice-paid-at.ts.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. It never inserts and never deletes, and it
 * writes only `paid_at`. Every write is a compare-and-set on the value that
 * was read, so a row someone changed in between is skipped, not overwritten.
 * A repaired row no longer matches the signature, so a second run finds
 * nothing to write. It never touches an invoice created in Accounted: no
 * settlement path in the product writes midnight UTC.
 *
 * A REFUSED WRITE STOPS THE RUN. A company that is the archived source of a
 * migration reset is immutable by trigger
 * (invoices_block_migration_reset_source_mutation). The script reports the
 * refusal and stops; it does not work around it.
 *
 * EXPECT MOSTLY NULLS. On 2026-09-20 no candidate row on prod had an
 * invoice_payments row (link_invoice_to_voucher refuses an invoice that is
 * already paid), so the run turns a wrong date into "Betald före migreringen
 * till Accounted." without a date. The real date needs part B.
 *
 * Usage:
 *   # Dry run (default): reports what it would write, writes nothing.
 *   npx tsx scripts/migration/repair-migrated-invoice-paid-at.ts --company <uuid>
 *
 *   # Apply.
 *   npx tsx scripts/migration/repair-migrated-invoice-paid-at.ts --company <uuid> --apply
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION: run the dry run first and read
 * its counts before passing --apply.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}

const USAGE =
  'Usage: npx tsx scripts/migration/repair-migrated-invoice-paid-at.ts --company <uuid> [--apply]'

const COMPANY_ID = argValue('--company')?.trim() ?? null
const APPLY = process.argv.includes('--apply')

// Refuse before touching env or the network: a run without an explicit
// company is never what support meant.
if (!COMPANY_ID) {
  console.error('--company <uuid> is required: this script never runs across companies.')
  console.error(USAGE)
  process.exit(1)
}
if (!UUID_RE.test(COMPANY_ID)) {
  console.error(`--company must be a uuid, got: ${COMPANY_ID}`)
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

async function main() {
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('id')
    .eq('id', COMPANY_ID)
    .maybeSingle()
  if (companyError) {
    console.error(`Could not read companies: ${companyError.message}`)
    process.exit(1)
  }
  if (!company) {
    console.error(`No company ${COMPANY_ID}.`)
    process.exit(1)
  }

  console.log('---------------------------------------------------------')
  console.log('Repair fabricated paid_at on migrated customer invoices')
  console.log('---------------------------------------------------------')
  console.log('Supabase URL :', SUPABASE_URL)
  console.log('Company      :', COMPANY_ID)
  console.log('Mode         :', APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------\n')

  // Imported here, not at the top: static imports are hoisted above the
  // dotenv() call, and modules under lib/ capture NEXT_PUBLIC_SUPABASE_URL
  // into a constant when they are first evaluated. The supplier-side script
  // hit exactly that on its first run (#2628); same rule here.
  const { repairMigratedInvoicePaidAt } = await import(
    '../../extensions/general/arcim-migration/lib/repair-migrated-invoice-paid-at'
  )
  const result = await repairMigratedInvoicePaidAt({
    supabase,
    companyId: COMPANY_ID!,
    dryRun: !APPLY,
  })

  // One machine-readable line, so a run can be pasted into a ticket as-is.
  console.log(JSON.stringify({ companyId: COMPANY_ID, ...result }))

  const verb = APPLY ? 'written' : 'would be written'
  const left = result.leftAlone
  console.log('')
  console.log(`Provider(s) on consents      : ${result.providers.join(', ') || '(none)'}`)
  console.log(`Candidates                   : ${result.candidates} paid invoice(s) with paid_at = invoice date at 00:00 UTC, created before #2769`)
  console.log(`Set to a real date           : ${result.setToDate} (${verb}; journal entry ${result.setToDateBySource.journal_entry}, provider ${result.setToDateBySource.provider})`)
  console.log(`Set to null                  : ${result.setToNull} (${verb})`)
  console.log('Left alone:')
  console.log(`  source confirms the date   : ${left.confirmedBySource}`)
  console.log(`  ambiguous payment rows     : ${left.ambiguousPaymentRows}`)
  console.log(`  provider may supply a date : ${left.providerMaySupplyDate}`)
  console.log(`  provider unknown           : ${left.providerUnknown}`)
  console.log(`  changed since read         : ${left.changedSinceRead}`)
  console.log(`  not written (run stopped)  : ${left.notWritten}`)
  console.log('')

  if (result.writeError) {
    console.error(
      `STOPPED: the database refused a write (${result.writeError.code ?? 'no code'}): ${result.writeError.message}`,
    )
    console.error('Nothing was worked around. Rows already written stay written; a re-run resumes.')
    process.exit(1)
  }
  if (!APPLY) {
    console.log('DRY RUN: nothing was written. Re-run with --apply to write these.')
  } else if (result.setToDate + result.setToNull === 0) {
    console.log('Nothing to write.')
  } else {
    console.log(`Done. ${result.setToDate + result.setToNull} invoice(s) no longer carry a fabricated payment date.`)
  }
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
