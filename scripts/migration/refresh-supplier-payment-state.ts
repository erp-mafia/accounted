#!/usr/bin/env npx tsx
/**
 * Support one-shot: refresh the payment state of migrated supplier invoices
 * from the provider that supplied them.
 *
 * WHY: a migration can only write what its mapper read. The Bokio
 * supplier-invoice mapper read `status` and `paidAmount`, neither of which
 * exists on Bokio's `supplierInvoiceGet` schema, so every imported invoice
 * landed as "Registrerad" with its whole total outstanding (365 invoices for
 * the company that reported it on 2026-09-14, 417 for a second Bokio
 * company). The mapper now reads `remainingAmount`, the payment field Bokio
 * does publish, but the rows already written stay wrong until something asks
 * the provider again. The in-app route (POST /reconcile) does this for a
 * member of the company; this script does the same for support, who is not a
 * member of the customer's company, using the service-role key.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. It never inserts and never deletes. It reads
 * the provider's own `remainingAmount` and writes only `status`,
 * `paid_amount`, `remaining_amount` and `paid_at`, only on supplier invoices
 * of the given company that carry no registration voucher, no payment
 * voucher, no payment (`paid_amount = 0`), are not credit notes and still
 * stand as registered/approved/overdue. A second run finds those rows already
 * settled, so they are no longer candidates and nothing is written. Anything
 * the provider still reports as open is left exactly as it is: re-running
 * cannot drift the reskontra.
 *
 * It does NOT correct a row that is already linked to a verifikat. If such a
 * row is ever wrong, BFL 5 kap 5 § applies and the correction goes through
 * storno (reverseEntry / correctEntry), case by case, never through a sweep.
 *
 * Usage:
 *   # Dry run (default): reports what it would write, writes nothing.
 *   npx tsx scripts/migration/refresh-supplier-payment-state.ts --company <uuid>
 *
 *   # Apply.
 *   npx tsx scripts/migration/refresh-supplier-payment-state.ts --company <uuid> --apply
 *
 *   # Use a specific consent instead of the company's latest accepted one.
 *   npx tsx scripts/migration/refresh-supplier-payment-state.ts --company <uuid> --consent <uuid>
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION: run the dry run first and read
 * its counts before passing --apply.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'

/**
 * Providers whose supplier register `fetchSupplierInvoicesDirect` can read
 * (lib/providers/provider-data-fetcher.ts). WINT is deliberately absent: its
 * incoming-invoice endpoint is Full-spec only and the fetcher returns an
 * empty list, which would report a silent "0 matched" run rather than a
 * refusal.
 */
const SUPPORTED_PROVIDERS = ['fortnox', 'visma', 'briox', 'bokio', 'bjornlunden'] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}

const USAGE =
  'Usage: npx tsx scripts/migration/refresh-supplier-payment-state.ts --company <uuid> [--consent <uuid>] [--apply]'

const COMPANY_ID = argValue('--company')?.trim() ?? null
const CONSENT_ID = argValue('--consent')?.trim() ?? null
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
if (CONSENT_ID && !UUID_RE.test(CONSENT_ID)) {
  console.error(`--consent must be a uuid, got: ${CONSENT_ID}`)
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

interface ConsentRow {
  id: string
  provider: string | null
  name: string | null
  company_name: string | null
  created_at: string
}

/** The consent to ask, either the one named on the command line or the company's latest accepted one. */
async function resolveConsentRow(): Promise<ConsentRow> {
  const query = supabase
    .from('provider_consents')
    .select('id, provider, name, company_name, created_at')
    .eq('company_id', COMPANY_ID)

  const { data, error } = CONSENT_ID
    ? await query.eq('id', CONSENT_ID).limit(1)
    // status 1 = Accepted. A consent still at 0 (token submitted, migration
    // pending) or revoked/inactive is not something to sweep a reskontra with.
    : await query.eq('status', 1).order('created_at', { ascending: false }).limit(1)

  if (error) {
    console.error(`Could not read provider_consents: ${error.message}`)
    process.exit(1)
  }
  const row = (data ?? [])[0] as ConsentRow | undefined
  if (!row) {
    console.error(
      CONSENT_ID
        ? `No provider consent ${CONSENT_ID} on company ${COMPANY_ID}.`
        : `No accepted provider consent (status 1) on company ${COMPANY_ID}. Nothing to ask.`,
    )
    process.exit(1)
  }
  if (!row.provider || !(SUPPORTED_PROVIDERS as readonly string[]).includes(row.provider)) {
    console.error(
      `Consent ${row.id} has provider "${row.provider ?? 'none'}", which this pass cannot read supplier `
      + `invoices from. Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    )
    process.exit(1)
  }
  return row
}

async function main() {
  const consent = await resolveConsentRow()

  console.log('---------------------------------------------------------')
  console.log('Refresh migrated supplier payment state')
  console.log('---------------------------------------------------------')
  console.log('Supabase URL :', SUPABASE_URL)
  console.log('Company      :', COMPANY_ID)
  console.log('Consent      :', `${consent.id} (${consent.provider}${consent.company_name ? `, ${consent.company_name}` : ''})`)
  console.log('Mode         :', APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------\n')

  // Imported here, not at the top: static imports are hoisted above the
  // dotenv() call, and lib/supabase/server.ts captures NEXT_PUBLIC_SUPABASE_URL
  // into a module constant when it is first evaluated. Loaded before the env,
  // that constant is undefined and every service client built from it fails
  // with "Your project's URL and Key are required" while the script's own
  // client (built after dotenv) works. First run on 2026-09-14 hit exactly that.
  const { refreshMigratedSupplierPaymentState } = await import(
    '../../src/extensions/general/arcim-migration/lib/refresh-migrated-payment-state'
  )
  const result = await refreshMigratedSupplierPaymentState({
    supabase,
    companyId: COMPANY_ID!,
    consentId: consent.id,
    dryRun: !APPLY,
  })

  // One machine-readable line, so a run can be pasted into a ticket as-is.
  console.log(JSON.stringify({ companyId: COMPANY_ID, consentId: consent.id, provider: consent.provider, ...result }))

  console.log('')
  console.log(`Provider returned      : ${result.providerInvoices} supplier invoice(s)`)
  console.log(`Matched open rows here : ${result.matched}`)
  console.log(`Settled at provider    : ${result.updated}${APPLY ? ' (written)' : ' (would be written)'}`)
  console.log(`Still open at provider : ${result.unchanged} (left untouched)`)
  console.log(`No open row here       : ${result.unmatched} (already booked, paid, never imported, or ambiguous join)`)
  console.log('')

  if (!APPLY) {
    console.log('DRY RUN: nothing was written. Re-run with --apply to write these.')
  } else if (result.updated === 0) {
    console.log('Nothing to write: every matched invoice is still open at the provider.')
  } else {
    console.log(`Done. ${result.updated} supplier invoice(s) now carry the provider's payment state.`)
  }
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
