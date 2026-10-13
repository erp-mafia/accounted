#!/usr/bin/env npx tsx
/**
 * crm#1157, step 3a: put the supplier's own invoice number back on supplier
 * invoices imported from Fortnox. The import stored Fortnox's löpnummer
 * (GivenNumber) as the supplier's number; the löpnummer stays on the invoice
 * in fortnox_number, which the Fortnox vouchers cite.
 *
 * The decisions happen in the repair_fortnox_supplier_invoice_numbers RPC
 * (migration 20261013133930), on all of a company's records in one call: it
 * corrects only a number that still is the löpnummer, applies crm#1039's
 * reused-number rule in invoice-date order (a number another live invoice of
 * the supplier keeps on another date becomes this invoice's payment
 * reference), and writes one SupplierInvoiceNumberCorrected
 * behandlingshistorik event per change in the same transaction. This script
 * collects the Fortnox records (lib/repair-fortnox-supplier-numbers.ts: stored
 * import payloads first, then Fortnox), shows the dry run, confirms and drives
 * the write.
 *
 * Run the write BEFORE step 2 (the mapper reading InvoiceNumber) is live: an
 * invoice still holding a löpnummer would otherwise make the import push a
 * real number into payment_reference.
 *
 * Dry run by default, for every company with Fortnox imports or one:
 *
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local --stored-only --out report.json
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local --out report.json
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local --company <uuid> --verbose
 *
 * A write needs the actor to record and a typed confirmation that repeats the
 * count of a fresh dry run, made in the same process:
 *
 *   # every company: the whole dry run and its summary, then ONE confirmation
 *   # of the total across all companies, then one RPC call (one transaction)
 *   # per company; a company that fails is listed at the end, the rest go on
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local \
 *     --actor-user-id <uuid> --execute
 *
 *   # one company, with a dry run of it afterwards
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local \
 *     --company <uuid> --actor-user-id <uuid> --execute
 *
 * The founder decides by reviewing the dry-run report and typing the total.
 *
 * Revert one run by the correlation id it printed (dry run by default; every
 * company that run changed, or --company). Each invoice that still holds what
 * the run wrote gets its number and payment reference from before the run
 * back, in reverse write order; one changed since, or whose old number another
 * invoice holds by now, is left alone and listed. One typed confirmation
 * `REVERT <n>`, then one RPC call (one transaction) per company:
 *
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local --revert <correlation-id>
 *   npx tsx scripts/repair-fortnox-supplier-invoice-numbers.ts --env .env.production.local --revert <correlation-id> \
 *     --actor-user-id <uuid> --execute
 *
 * A revert needs only NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 *
 * Env (the file given with --env is the only source; the banner prints the URL):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   the database
 *   PERSONNUMMER_ENCRYPTION_KEY                           opens the stored import payloads
 *   FORTNOX_CLIENT_ID, FORTNOX_CLIENT_SECRET,             only without --stored-only: an expired
 *   FORTNOX_REDIRECT_URI                                  access token is refreshed with them
 *
 * Without --stored-only a company whose invoices are not all covered by a
 * stored payload is read from Fortnox. That resolves its connection exactly as
 * a sync does: an expired access token is refreshed and the rotated token pair
 * is stored. A connection that cannot be resolved is reported as
 * consent_expired; that company is repaired when it reconnects.
 *
 * The summary at the end (also in --out) gives the totals per outcome, the
 * companies that paid or ordered a payment from Accounted with the löpnummer
 * as reference (the ones we tell), and the companies whose records could not
 * all be read (repaired when they reconnect).
 *
 * Flags:
 *   --env <file>          env file to load (default .env.local, which is NOT prod)
 *   --company <uuid>      restrict to one company
 *   --stored-only         read stored import payloads only, never call Fortnox
 *   --actor-user-id <id>  the person running the repair, recorded as the actor
 *   --execute             write; without it nothing is changed
 *   --out <file>          also write the dry-run report and summary as JSON
 *   --revert <uuid>       revert the run with this correlation id instead of repairing
 *   --verbose             print every record's outcome
 */

import { config } from 'dotenv'
import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const ENV_FILE = arg('env') ?? '.env.local'
const loaded = config({ path: ENV_FILE, override: true })
if (loaded.error) {
  console.error(`Cannot read ${ENV_FILE}: ${loaded.error.message}`)
  process.exit(1)
}

const COMPANY_ID = arg('company') ?? null
const ACTOR_USER_ID = arg('actor-user-id') ?? null
const EXECUTE = flag('execute')
const STORED_ONLY = flag('stored-only')
const VERBOSE = flag('verbose')
const OUT_FILE = arg('out') ?? null
const REVERT_ID = arg('revert') ?? null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const missing = [
  ['NEXT_PUBLIC_SUPABASE_URL', supabaseUrl],
  ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
  ...(REVERT_ID ? [] : [['PERSONNUMMER_ENCRYPTION_KEY', process.env.PERSONNUMMER_ENCRYPTION_KEY]]),
  ...(STORED_ONLY || REVERT_ID ? [] : [
    ['FORTNOX_CLIENT_ID', process.env.FORTNOX_CLIENT_ID],
    ['FORTNOX_CLIENT_SECRET', process.env.FORTNOX_CLIENT_SECRET],
    ['FORTNOX_REDIRECT_URI', process.env.FORTNOX_REDIRECT_URI],
  ]),
].filter(([, value]) => !value).map(([name]) => name)
if (missing.length > 0) {
  console.error(`Missing in ${ENV_FILE}: ${missing.join(', ')}`)
  process.exit(1)
}
if (COMPANY_ID && !UUID_RE.test(COMPANY_ID)) {
  console.error('--company must be a uuid')
  process.exit(1)
}
if (REVERT_ID && !UUID_RE.test(REVERT_ID)) {
  console.error('--revert must be the correlation id (uuid) the repair printed')
  process.exit(1)
}
if (EXECUTE && (!ACTOR_USER_ID || !UUID_RE.test(ACTOR_USER_ID))) {
  console.error('--execute needs --actor-user-id <uuid> (recorded in behandlingshistorik)')
  process.exit(1)
}

const supabase: SupabaseClient = createClient(supabaseUrl as string, serviceRoleKey as string, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Loaded after the env file: the provider and payload modules read their
// settings when they are first imported.
type Lib = typeof import('@/extensions/general/arcim-migration/lib/repair-fortnox-supplier-numbers')
type CompanyRepairResult = Awaited<ReturnType<Lib['repairFortnoxSupplierNumbers']>>
type RepairRows = CompanyRepairResult['rows']
let lib: Lib

const ACTOR = () => ({
  type: 'user' as const,
  id: ACTOR_USER_ID as string,
  label: 'scripts/repair-fortnox-supplier-invoice-numbers.ts (crm#1157)',
})

interface Company {
  id: string
  name: string
  archived: boolean
}

interface CompanyRun {
  company: Company
  result?: CompanyRepairResult
  error?: string
}

interface Summary {
  totals: Record<string, number>
  /** Invoices the write changes: a new number or payment reference, or a stamped löpnummer. */
  toWrite: number
  /** Paid or ordered from Accounted with the löpnummer as reference: the companies we tell. */
  paidWithLopnummer: { company_id: string; name: string; count: number }[]
  /** Records not all read: repaired when they reconnect. */
  notRead: { company_id: string; name: string; reason: string }[]
  errors: { company_id: string; name: string; error: string }[]
}

async function pagedIds(table: string, column: string): Promise<string[]> {
  const ids = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(column).eq('provider', 'fortnox')
      .order(column).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = (data ?? []) as unknown as Record<string, string>[]
    for (const row of rows) ids.add(row[column])
    if (rows.length < 1000) break
  }
  return [...ids]
}

/** Every company that ever connected Fortnox or ran a Fortnox import. */
async function fortnoxCompanies(): Promise<Company[]> {
  return companiesById(COMPANY_ID ? [COMPANY_ID] : [...new Set([
    ...(await pagedIds('provider_consents', 'company_id')),
    ...(await pagedIds('migration_jobs', 'company_id')),
  ])])
}

async function companiesById(ids: string[]): Promise<Company[]> {
  const companies: Company[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('companies').select('id, name, archived_at').in('id', ids.slice(i, i + 100))
    if (error) throw new Error(`companies: ${error.message}`)
    for (const c of (data ?? []) as { id: string; name: string | null; archived_at: string | null }[]) {
      companies.push({ id: c.id, name: c.name ?? '', archived: c.archived_at !== null })
    }
  }
  return companies.sort((a, b) => a.name.localeCompare(b.name, 'sv'))
}

function countsLine(counts: Record<string, number | undefined>): string {
  const order = ['corrected', 'reused_number', 'already_correct', 'no_supplier_number', 'changed_by_user',
    'number_taken', 'header_mismatch', 'ambiguous', 'not_found', 'invalid_row']
  return order.filter((k) => counts[k]).map((k) => `${k}=${counts[k]}`).join(' ') || '-'
}

function writes(rows: RepairRows): number {
  return rows.filter((r) => r.outcome === 'corrected' || r.outcome === 'reused_number' || r.stamped).length
}

function paidWithLopnummer(rows: RepairRows): number {
  return rows.filter((r) => (r.old_reference_used ?? []).length > 0).length
}

function printRows(rows: RepairRows) {
  for (const r of rows) {
    const refs = r.old_reference_used.map((x) => `${x.source}:${x.status}:${x.date ?? '-'}`).join(',')
    const after = r.outcome === 'reused_number' ? `(none), payment reference ${r.payment_reference}` : (r.new_number ?? '-')
    console.log(`    ${String(r.given_number ?? '-').padStart(8)}  ${r.invoice_id ?? '-'}  ${r.outcome.padEnd(18)}` +
      `  ${r.old_number ?? '-'} -> ${after}${r.stamped ? '  +fortnox_number' : ''}${refs ? `  paid with löpnummer: ${refs}` : ''}`)
  }
}

async function confirm(expected: number, what: string, word = 'REPAIR'): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`\nType "${word} ${expected}" to write ${what}: `)
    if (answer.trim() !== `${word} ${expected}`) {
      console.log('Aborted, nothing written.')
      process.exit(2)
    }
  } finally {
    rl.close()
  }
}

async function dryRunAll(companies: Company[]): Promise<CompanyRun[]> {
  const runs: CompanyRun[] = []
  for (const company of companies) {
    if (company.archived) {
      console.log(`  ${company.id}  archived, skipped  ${company.name}`)
      continue
    }
    try {
      const result = await lib.repairFortnoxSupplierNumbers(supabase, company.id,
        { dryRun: true, fetchFromFortnox: !STORED_ONLY })
      const c = result.collection
      const paid = paidWithLopnummer(result.rows)
      console.log(`  ${company.id}  ${result.status.padEnd(13)} stored=${c?.stored ?? 0} fetched=${c?.fetched ?? 0} ` +
        `fortnox=${c?.fortnox ?? '-'} unlinked=${c?.uncovered ?? 0}  ${countsLine(result.counts)}` +
        `${paid ? `  paid_with_lopnummer=${paid}` : ''}  ${company.name}${c?.fortnoxError ? `\n      fortnox: ${c.fortnoxError}` : ''}`)
      if (VERBOSE) printRows(result.rows)
      runs.push({ company, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  ${company.id}  ERROR ${message}  ${company.name}`)
      runs.push({ company, error: message })
    }
  }
  return runs
}

function notReadReason(result: CompanyRepairResult): string | null {
  const c = result.collection
  if (!c) return null
  const reasons: string[] = []
  if ((c.fortnox === 'consent_expired' || c.fortnox === 'no_consent') && c.uncovered > 0) reasons.push(c.fortnox)
  if (c.fortnox === 'failed') reasons.push(`failed: ${c.fortnoxError ?? 'unknown'}`)
  if (c.fortnox === 'skipped' && c.uncovered > 0) reasons.push(`stored payloads only, ${c.uncovered} unlinked`)
  if (c.unreadable > 0) reasons.push(`${c.unreadable} unreadable payloads`)
  return reasons.length ? reasons.join('; ') : null
}

function summarize(runs: CompanyRun[]): Summary {
  const summary: Summary = { totals: {}, toWrite: 0, paidWithLopnummer: [], notRead: [], errors: [] }
  for (const run of runs) {
    if (run.error) {
      summary.errors.push({ company_id: run.company.id, name: run.company.name, error: run.error })
      continue
    }
    const result = run.result
    if (!result) continue
    for (const [k, v] of Object.entries(result.counts)) summary.totals[k] = (summary.totals[k] ?? 0) + (v ?? 0)
    if (result.status === 'dry_run') summary.toWrite += writes(result.rows)
    const paid = paidWithLopnummer(result.rows)
    if (paid > 0) summary.paidWithLopnummer.push({ company_id: run.company.id, name: run.company.name, count: paid })
    const reason = notReadReason(result)
    if (reason) summary.notRead.push({ company_id: run.company.id, name: run.company.name, reason })
  }
  return summary
}

function printSummary(summary: Summary, runs: CompanyRun[]) {
  console.log('\n---------------------------------------------------------')
  console.log(`Total: ${countsLine(summary.totals)}`)
  console.log(`Invoices a write changes: ${summary.toWrite}`)
  const blocked = runs.filter((r) => r.result?.status === 'field_missing').map((r) => r.company.name)
  if (blocked.length) console.log(`\nNo InvoiceNumber in any record, never repaired (check the field name): ${blocked.join(', ')}`)
  console.log(`\nPaid or ordered from Accounted with the löpnummer as reference (the ones we tell): ${summary.paidWithLopnummer.length}`)
  for (const p of summary.paidWithLopnummer) console.log(`  ${p.company_id}  ${p.count}  ${p.name}`)
  console.log(`\nRecords not all read (repaired when they reconnect): ${summary.notRead.length}`)
  for (const n of summary.notRead) console.log(`  ${n.company_id}  ${n.reason}  ${n.name}`)
  if (summary.errors.length) {
    console.log(`\nErrors: ${summary.errors.length}`)
    for (const e of summary.errors) console.log(`  ${e.company_id}  ${e.error}  ${e.name}`)
  }
}

function writeReport(runs: CompanyRun[], summary: Summary) {
  if (!OUT_FILE) return
  const companies = runs.map((run) => ({
    company: run.company.id,
    name: run.company.name,
    ...(run.error ? { error: run.error } : {}),
    ...(run.result ? {
      ...run.result,
      collection: run.result.collection ? { ...run.result.collection, records: run.result.collection.records.length } : null,
    } : {}),
  }))
  writeFileSync(OUT_FILE, JSON.stringify({ summary, companies }, null, 2))
  console.log(`\nFull report: ${OUT_FILE}`)
}

async function executeAll(runs: CompanyRun[], summary: Summary) {
  const toApply = runs.filter((r) => r.result?.status === 'dry_run' && writes(r.result.rows) > 0)
  if (summary.toWrite === 0 || toApply.length === 0) {
    console.log('\nNothing to write.')
    return
  }
  await confirm(summary.toWrite, `these ${summary.toWrite} invoices in ${toApply.length} companies`)

  const correlationId = randomUUID()
  const failures: { company: Company; error: string }[] = []
  const totals: Record<string, number> = {}
  for (const run of toApply) {
    const result = run.result as CompanyRepairResult
    try {
      // The records of the dry run above, decided again under the write's
      // lock in one transaction for this company.
      const written = await lib.applyFortnoxNumberRepair(supabase, run.company.id,
        result.collection?.records ?? [], { dryRun: false, actor: ACTOR(), correlationId })
      for (const [k, v] of Object.entries(written.counts)) totals[k] = (totals[k] ?? 0) + (v ?? 0)
      console.log(`  ${run.company.id}  written  ${countsLine(written.counts)}  ${run.company.name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ company: run.company, error: message })
      console.log(`  ${run.company.id}  FAILED ${message}  ${run.company.name}`)
    }
  }
  console.log(`\nWritten (correlation ${correlationId}): ${countsLine(totals)}`)
  if (failures.length) {
    console.log(`\nFailed, nothing written for these (rerun them with --company): ${failures.length}`)
    for (const f of failures) console.log(`  ${f.company.id}  ${f.error}  ${f.company.name}`)
    process.exitCode = 1
  }
}

async function executeOne(company: Company) {
  if (company.archived) {
    console.error('This company is archived. Nothing written.')
    process.exit(1)
  }
  if (await lib.isMigrationResetSource(supabase, company.id)) {
    console.error('This company is a migration-reset source and stays frozen. Nothing written.')
    process.exit(1)
  }
  const collection = await lib.collectFortnoxRecords(supabase, company.id, { fetchFromFortnox: !STORED_ONLY })
  console.log(`Records: stored=${collection.stored} fetched=${collection.fetched} fortnox=${collection.fortnox}` +
    `${collection.fortnoxError ? ` (${collection.fortnoxError})` : ''} unreadable=${collection.unreadable}`)
  const blocker = lib.repairBlocker(collection)
  if (blocker) {
    console.error(`Not repaired: ${blocker}. Nothing written.`)
    process.exit(1)
  }

  const dry = await lib.applyFortnoxNumberRepair(supabase, company.id, collection.records, { dryRun: true })
  console.log(`\nDry run: ${countsLine(dry.counts)}`)
  if (VERBOSE) printRows(dry.rows)
  const toWrite = writes(dry.rows)
  if (toWrite === 0) {
    console.log('\nNothing to write for this company.')
    return
  }
  await confirm(toWrite, `these ${toWrite} invoices`)

  const correlationId = randomUUID()
  const written = await lib.applyFortnoxNumberRepair(supabase, company.id, collection.records,
    { dryRun: false, actor: ACTOR(), correlationId })
  console.log(`\nWritten (correlation ${correlationId}): ${countsLine(written.counts)}`)
  const paid = written.rows.filter((r) => r.old_reference_used.length > 0)
  if (paid.length) {
    console.log(`${paid.length} of these were paid or ordered from Accounted with the löpnummer as reference:`)
    printRows(paid)
  }

  const after = await lib.applyFortnoxNumberRepair(supabase, company.id, collection.records, { dryRun: true })
  console.log(`After: ${countsLine(after.counts)} (corrected and reused_number must be absent)`)
}

async function revertRun(repairId: string) {
  const companies = await companiesById(COMPANY_ID ? [COMPANY_ID] : await lib.correctedCompanies(supabase, repairId))
  if (companies.length === 0) {
    console.log('This run changed no invoices.')
    return
  }
  console.log(`${companies.length} companies\n`)
  const toRevert: { company: Company; n: number }[] = []
  const errors: { company: Company; error: string }[] = []
  const totals: Record<string, number> = {}
  for (const company of companies) {
    try {
      const dry = await lib.revertFortnoxNumberRepair(supabase, company.id, repairId, { dryRun: true })
      for (const [k, v] of Object.entries(dry.counts)) totals[k] = (totals[k] ?? 0) + (v ?? 0)
      const counts = Object.entries(dry.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '-'
      console.log(`  ${company.id}  ${counts}  ${company.name}`)
      if (VERBOSE) {
        for (const r of dry.rows) {
          console.log(`    ${r.invoice_id}  ${r.outcome.padEnd(13)}  ${r.current.supplier_invoice_number ?? '-'}` +
            ` / ${r.current.payment_reference ?? '-'} -> ${r.restore.supplier_invoice_number ?? '-'} / ${r.restore.payment_reference ?? '-'}`)
        }
      }
      if ((dry.counts.reverted ?? 0) > 0) toRevert.push({ company, n: dry.counts.reverted ?? 0 })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ company, error: message })
      console.log(`  ${company.id}  ERROR ${message}  ${company.name}`)
    }
  }
  const total = toRevert.reduce((n, r) => n + r.n, 0)
  console.log(`\nTotal: ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`)
  console.log('changed_since and number_taken invoices are left as they are.')
  if (errors.length) {
    console.log(`\nErrors (not reverted): ${errors.length}`)
    for (const e of errors) console.log(`  ${e.company.id}  ${e.error}  ${e.company.name}`)
  }
  if (!EXECUTE) {
    console.log('\nDry run only. Re-run with --actor-user-id <uuid> --execute to revert.')
    return
  }
  if (total === 0) {
    console.log('\nNothing to revert.')
    return
  }
  await confirm(total, `back these ${total} invoices in ${toRevert.length} companies`, 'REVERT')
  const failures: { company: Company; error: string }[] = []
  for (const { company } of toRevert) {
    try {
      const written = await lib.revertFortnoxNumberRepair(supabase, company.id, repairId, { dryRun: false, actor: ACTOR() })
      const counts = Object.entries(written.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '-'
      console.log(`  ${company.id}  reverted (correlation ${written.correlationId})  ${counts}  ${company.name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ company, error: message })
      console.log(`  ${company.id}  FAILED ${message}  ${company.name}`)
    }
  }
  if (failures.length) {
    console.log(`\nFailed, nothing reverted for these (rerun them with --company): ${failures.length}`)
    for (const f of failures) console.log(`  ${f.company.id}  ${f.error}  ${f.company.name}`)
    process.exitCode = 1
  }
}

async function main() {
  lib = await import('@/extensions/general/arcim-migration/lib/repair-fortnox-supplier-numbers')
  console.log('---------------------------------------------------------')
  console.log('Fortnox supplier invoice number repair (crm#1157)')
  console.log('---------------------------------------------------------')
  console.log('Env file    :', ENV_FILE)
  console.log('Supabase URL:', supabaseUrl)
  console.log('Company     :', COMPANY_ID ?? (REVERT_ID ? '(every company the run changed)' : '(every company with Fortnox)'))
  if (REVERT_ID) console.log('Revert run  :', REVERT_ID)
  else console.log('Sources     :', STORED_ONLY ? 'stored import payloads only' : 'stored import payloads, then Fortnox')
  console.log('Mode        :', EXECUTE ? 'EXECUTE (writes after the dry run and your confirmation)' : 'DRY RUN (no writes)')
  console.log('---------------------------------------------------------')

  if (REVERT_ID) {
    await revertRun(REVERT_ID)
    return
  }

  const companies = await fortnoxCompanies()
  if (COMPANY_ID && companies.length === 0) {
    console.error('No such company.')
    process.exit(1)
  }
  if (EXECUTE && COMPANY_ID) {
    await executeOne(companies[0])
    return
  }
  console.log(`${companies.length} companies\n`)
  const runs = await dryRunAll(companies)
  const summary = summarize(runs)
  printSummary(summary, runs)
  writeReport(runs, summary)
  if (EXECUTE) {
    await executeAll(runs, summary)
    return
  }
  console.log('\nDry run only. Re-run with --actor-user-id <uuid> --execute (optionally --company <uuid>) to write.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
