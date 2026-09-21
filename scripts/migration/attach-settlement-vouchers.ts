#!/usr/bin/env npx tsx
/**
 * Support one-shot: attach the verifikat that paid each ALREADY settled
 * supplier invoice, from a list the customer supplies.
 *
 * WHY: a provider migration brings the general ledger in through SIE and the
 * supplier register through the provider API. An invoice the provider reports
 * as settled lands as 'paid' with no supplier_invoice_payments row, because the
 * provider names neither a payment date nor a payment voucher (Bokio publishes
 * no payments endpoint for supplier invoices at all). The invoice page then
 * shows no paying verifikat, and the kontantmetoden year-end cut-off, which
 * reads the rows and nothing else, counts every such invoice as a
 * leverantörsskuld at year end. The customer is the one who knows which
 * verifikat paid which invoice; this script takes that list and writes the
 * missing rows.
 *
 * EVERY RULE LIVES IN THE DATABASE, in attach_supplier_invoice_settlement_voucher
 * (migration 20260921084700). This script only resolves the customer's numbers
 * to ids (lib/invoices/attach-settlement-voucher.ts) and calls it pair by pair.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. The one write per pair is a single
 * supplier_invoice_payments row, dated at the verifikat. supplier_invoices is
 * never updated and no journal table is touched. A pair that is already
 * attached reports 'already_linked' and writes nothing. Every row carries the
 * note marker 'settlement-evidence', so a run can be found again:
 *   SELECT * FROM supplier_invoice_payments
 *   WHERE company_id = '<uuid>' AND notes LIKE 'settlement-evidence%';
 * A run that went wrong can be undone by deleting exactly those rows, but ONLY
 * while nothing has relied on them. Once a bokslut or a kontantmetoden cut-off
 * has been posted with the rows in place they are part of what that figure
 * rests on (BFL 5 kap 5 §: a correction may not erase the original without a
 * trace), so they are left alone and the correction goes through the cut-off.
 *
 * Input: a JSON array, one object per pair.
 *   [
 *     { "supplier_invoice_number": "1001", "voucher": "V342", "voucher_date": "2026-05-07" },
 *     { "supplier_invoice_number": "1001", "invoice_date": "2026-06-01",
 *       "voucher": "V17", "voucher_date": "2026-06-20" }
 *   ]
 *   voucher        the verifikat as the OLD system numbered it (series + number)
 *   voucher_date   that verifikat's date: old systems restart numbering every
 *                  fiscal year, so the date is what picks the year
 *   invoice_date   only needed when two invoices share a number
 *
 * Usage:
 *   # Dry run (default): every check runs against the real rules, nothing is written.
 *   npx tsx scripts/migration/attach-settlement-vouchers.ts --company <uuid> --file links.json
 *
 *   # Apply.
 *   npx tsx scripts/migration/attach-settlement-vouchers.ts --company <uuid> --file links.json --apply
 *
 *   # Attribute the rows to a specific user instead of the company's owner,
 *   # and write the full per-pair report to a file.
 *   ... --user <uuid> --out report.json
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION: run the dry run first and read
 * its counts before passing --apply.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}

const USAGE =
  'Usage: npx tsx scripts/migration/attach-settlement-vouchers.ts --company <uuid> --file <links.json> [--user <uuid>] [--out <report.json>] [--apply]'

const COMPANY_ID = argValue('--company')?.trim() ?? null
const FILE = argValue('--file')?.trim() ?? null
const USER_ID = argValue('--user')?.trim() ?? null
const OUT = argValue('--out')?.trim() ?? null
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
if (USER_ID && !UUID_RE.test(USER_ID)) {
  console.error(`--user must be a uuid, got: ${USER_ID}`)
  process.exit(1)
}
if (!FILE) {
  console.error('--file <links.json> is required.')
  console.error(USAGE)
  process.exit(1)
}

let links: unknown
try {
  links = JSON.parse(readFileSync(resolve(process.cwd(), FILE), 'utf8'))
} catch (error) {
  console.error(`Could not read ${FILE} as JSON: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
if (!Array.isArray(links) || links.length === 0) {
  console.error(`${FILE} must hold a non-empty JSON array of pairs.`)
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

/** The user the rows are attributed to: the one named, or the company's owner. */
async function resolveActingUser(): Promise<string> {
  if (USER_ID) {
    const { data, error } = await supabase
      .from('company_members')
      .select('user_id')
      .eq('company_id', COMPANY_ID)
      .eq('user_id', USER_ID)
      // A writing role, as the RLS insert policy demands of a user session:
      // the row must not be attributed to someone who could never have written it.
      .in('role', ['owner', 'admin', 'member'])
      .limit(1)
    if (error) {
      console.error(`Could not read company_members: ${error.message}`)
      process.exit(1)
    }
    if (!data || data.length === 0) {
      console.error(`User ${USER_ID} is not a writing member (owner, admin or member) of company ${COMPANY_ID}.`)
      process.exit(1)
    }
    return USER_ID
  }
  const { data, error } = await supabase
    .from('company_members')
    .select('user_id, created_at')
    .eq('company_id', COMPANY_ID)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) {
    console.error(`Could not read company_members: ${error.message}`)
    process.exit(1)
  }
  const owner = (data ?? [])[0] as { user_id: string } | undefined
  if (!owner) {
    console.error(`Company ${COMPANY_ID} has no owner to attribute the rows to. Pass --user <uuid>.`)
    process.exit(1)
  }
  return owner.user_id
}

async function main() {
  const userId = await resolveActingUser()

  console.log('---------------------------------------------------------')
  console.log('Attach settlement vouchers to settled supplier invoices')
  console.log('---------------------------------------------------------')
  console.log('Supabase URL :', SUPABASE_URL)
  console.log('Company      :', COMPANY_ID)
  console.log('Acting user  :', userId, USER_ID ? '(named)' : '(company owner)')
  console.log('Pairs        :', (links as unknown[]).length, `from ${FILE}`)
  console.log('Mode         :', APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------\n')

  // Imported here, not at the top: static imports are hoisted above the
  // dotenv() call, and app modules capture env into module constants when they
  // are first evaluated (see refresh-supplier-payment-state.ts, first run on
  // 2026-09-14).
  const { attachSettlementVouchersBatch } = await import('../../lib/invoices/attach-settlement-voucher')
  const result = await attachSettlementVouchersBatch(supabase, {
    companyId: COMPANY_ID!,
    userId,
    links: links as never,
    dryRun: !APPLY,
    notes: `support run ${new Date().toISOString().slice(0, 10)}`,
  })

  // One machine-readable line, so a run can be pasted into a ticket as-is.
  console.log(JSON.stringify({ companyId: COMPANY_ID, dryRun: result.dryRun, total: result.total, ...result.counts }))
  console.log('')
  console.log(`${APPLY ? 'Attached            ' : 'Would attach        '}: ${APPLY ? result.counts.attached : result.counts.would_attach}`)
  console.log(`Already attached    : ${result.counts.already_linked}`)
  console.log(`Refused by the rules: ${result.counts.refused}`)
  console.log(`Invoice not found   : ${result.counts.invoice_not_found}`)
  console.log(`Invoice ambiguous   : ${result.counts.invoice_ambiguous} (add invoice_date)`)
  console.log(`Verifikat not found : ${result.counts.voucher_not_found}`)
  console.log(`Malformed rows      : ${result.counts.invalid_input}`)
  console.log(`Errors              : ${result.counts.error}`)

  const problems = result.reports.filter(
    (r) => r.outcome !== 'attached' && r.outcome !== 'would_attach' && r.outcome !== 'already_linked',
  )
  if (problems.length > 0) {
    console.log(`\nFirst ${Math.min(problems.length, 25)} of ${problems.length} pair(s) that did not attach:`)
    for (const r of problems.slice(0, 25)) {
      const label = `${r.input?.supplier_invoice_number ?? '?'} -> ${r.input?.voucher ?? '?'}`
      console.log(`  #${r.index} ${label}: ${r.outcome}${r.code ? ` ${r.code}` : ''}${r.reason ? ` (${r.reason})` : ''}`)
    }
  }

  if (OUT) {
    writeFileSync(resolve(process.cwd(), OUT), JSON.stringify(result, null, 2))
    console.log(`\nFull per-pair report written to ${OUT}`)
  }

  console.log('')
  if (!APPLY) {
    console.log('DRY RUN: nothing was written. Re-run with --apply to write these.')
  } else {
    console.log(`Done. ${result.counts.attached} supplier invoice(s) now carry the verifikat that paid them.`)
  }
  if (result.counts.error > 0) process.exit(2)
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
