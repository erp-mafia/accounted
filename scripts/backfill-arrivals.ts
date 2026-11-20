#!/usr/bin/env npx tsx
/**
 * Backfill arrivals for inbox items filed before arrivals existed.
 *
 * Reads invoice_inbox_items (and the WhatsApp messages and documents they
 * point at), plans one arrival per delivery (src/lib/intake/backfill.ts) and,
 * with --apply, records them through src/lib/intake/arrivals.ts:
 *
 *   email      one arrival per Resend email id and company: sender, subject,
 *              text; no .eml (the raw copy was never fetched)
 *   whatsapp   one per message: caption and masked sender, no original
 *              (chat transcripts are purged at 90 days and are not copied)
 *   peppol     one per provider document: points at the archived XML
 *   mail_hunt  one per hunted message (Gmail or Microsoft), source 'mailbox':
 *              the envelope only, never the body
 *   upload     one per document: points at the uploaded file itself
 *
 * Idempotent: arrivals are keyed on (company, source, source_ref) and their
 * outputs on (arrival, kind, output), so a second run, or a run that meets an
 * arrival the live doors already recorded, adds nothing twice.
 *
 * Writes are append-only rows only; no Storage object is written (every
 * original a backfill can name is already archived). Nothing existing is
 * changed or deleted.
 *
 * SAFETY
 *   * The default is a DRY RUN: it reads and prints counts, writes nothing.
 *   * --apply is required to write, and asks for the project ref unless --yes.
 *   * --env <file> is required and .env.local is refused: it points at
 *     production. Run against staging first.
 *
 * USAGE
 *   npx tsx scripts/backfill-arrivals.ts --env .env.staging.local
 *   npx tsx scripts/backfill-arrivals.ts --env .env.staging.local --company <uuid> --limit 500
 *   npx tsx scripts/backfill-arrivals.ts --env .env.staging.local --apply
 *
 * FLAGS
 *   --env <file>       dotenv file to load. REQUIRED.
 *   --apply            record the arrivals (default: dry run).
 *   --company <uuid>   only this company's inbox items.
 *   --limit <n>        stop after n inbox items.
 *   --yes              skip the confirmation prompt.
 */

import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { linkArrivalOutputs, recordArrival } from '@/lib/intake/arrivals'
import {
  documentIdsToRead,
  planArrivals,
  whatsappIdsToRead,
  type BackfillDocument,
  type BackfillInboxItem,
  type BackfillWhatsAppMessage,
  type PlannedArrival,
} from '@/lib/intake/backfill'

const PAGE_SIZE = 500
const LOOKUP_CHUNK = 200

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return undefined
  const value = process.argv[idx + 1]
  if (!value || value.startsWith('--')) {
    console.error(`--${name} requires a value`)
    process.exit(1)
  }
  return value
}

const envFile = flagValue('env')
const apply = process.argv.includes('--apply')
const skipPrompt = process.argv.includes('--yes')
const onlyCompany = flagValue('company')
const limitRaw = flagValue('limit')
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY

if (!envFile) {
  console.error('Refusing to run without an explicit --env <file>. Example: --env .env.staging.local')
  process.exit(1)
}
// Normalised before comparing, so './.env.local' is refused too; checked
// before config() so the production file is never read.
if (basename(resolve(envFile)).toLowerCase() === '.env.local') {
  console.error(
    'REFUSING: .env.local points at the production database. Copy the credentials into an ' +
      'explicitly named file (e.g. .env.production.backfill) so the intent is on the command line.',
  )
  process.exit(1)
}
if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
  console.error('--limit must be a positive integer.')
  process.exit(1)
}
if (onlyCompany && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(onlyCompany)) {
  console.error('--company must be a UUID.')
  process.exit(1)
}

config({ path: envFile })
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`)
  process.exit(1)
}

function projectRef(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0] ?? url
  } catch {
    return url
  }
}

async function confirmOrExit(): Promise<void> {
  const ref = projectRef(supabaseUrl!)
  console.log('')
  console.log('='.repeat(78))
  console.log('  arrivals backfill: one arrival per delivery for existing inbox items')
  console.log('='.repeat(78))
  console.log(`  env file        : ${envFile}`)
  console.log(`  supabase project: ${ref}`)
  console.log(`  mode            : ${apply ? 'APPLY (records arrivals)' : 'DRY RUN (no changes)'}`)
  console.log(`  company filter  : ${onlyCompany ?? '(all companies)'}`)
  console.log(`  limit           : ${Number.isFinite(limit) ? limit : '(none)'}`)
  console.log('='.repeat(78))
  console.log('')
  if (!apply || skipPrompt) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`Type the project ref (${ref}) to proceed, anything else to abort: `)
  rl.close()
  if (answer.trim() !== ref) {
    console.error('Aborted.')
    process.exit(1)
  }
}

function chunks(ids: string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) out.push(ids.slice(i, i + LOOKUP_CHUNK))
  return out
}

async function readWhatsAppMessages(supabase: SupabaseClient, ids: string[]): Promise<BackfillWhatsAppMessage[]> {
  const out: BackfillWhatsAppMessage[] = []
  for (const chunk of chunks(ids)) {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('id, wamid, body_text, raw_payload, created_at, phone_link_id, message_type, media_mime')
      .in('id', chunk)
    if (error) throw new Error(`whatsapp_messages lookup failed: ${error.message}`)
    out.push(...((data as unknown as BackfillWhatsAppMessage[] | null) ?? []))
  }
  return out
}

async function readDocuments(supabase: SupabaseClient, ids: string[]): Promise<BackfillDocument[]> {
  const out: BackfillDocument[] = []
  for (const chunk of chunks(ids)) {
    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, storage_path, sha256_hash, mime_type, file_size_bytes, file_name, upload_source')
      .in('id', chunk)
    if (error) throw new Error(`document_attachments lookup failed: ${error.message}`)
    out.push(...((data as unknown as BackfillDocument[] | null) ?? []))
  }
  return out
}

interface Totals {
  items: number
  deliveries: Set<string>
  bySource: Map<string, number>
  outputs: number
  withOriginal: number
  skipped: Map<string, number>
  created: number
  existing: number
  failed: number
}

async function record(supabase: SupabaseClient, planned: PlannedArrival, totals: Totals): Promise<void> {
  const result = await recordArrival(supabase, {
    companyId: planned.companyId,
    source: planned.source,
    sourceRef: planned.sourceRef,
    receivedAt: planned.receivedAt,
    sender: planned.sender,
    subject: planned.subject,
    messageText: planned.messageText,
    fetchedBy: planned.fetchedBy,
    sourceMeta: planned.sourceMeta,
    originalRef: planned.originalRef,
  })
  if (!result) {
    totals.failed += 1
    console.error(`  failed: ${planned.key}`)
    return
  }
  if (result.created) totals.created += 1
  else totals.existing += 1
  const linked = await linkArrivalOutputs(supabase, result.arrival, planned.outputs)
  if (!linked) console.error(`  outputs not linked: ${planned.key}`)
}

async function main(): Promise<void> {
  await confirmOrExit()
  const supabase = createClient(supabaseUrl!, serviceRoleKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const totals: Totals = {
    items: 0,
    deliveries: new Set(),
    bySource: new Map(),
    outputs: 0,
    withOriginal: 0,
    skipped: new Map(),
    created: 0,
    existing: 0,
    failed: 0,
  }

  for (let offset = 0; totals.items < limit; offset += PAGE_SIZE) {
    const pageSize = Math.min(PAGE_SIZE, limit - totals.items)
    let query = supabase
      .from('invoice_inbox_items')
      .select(
        'id, company_id, user_id, source, document_id, created_at, email_from, email_subject, email_received_at, email_body_text, resend_email_id, resend_attachment_id, raw_email_payload, whatsapp_message_id, channel_context',
      )
      .order('id', { ascending: true })
    if (onlyCompany) query = query.eq('company_id', onlyCompany)
    const { data, error } = await query.range(offset, offset + pageSize - 1)
    if (error) throw new Error(`invoice_inbox_items page at ${offset} failed: ${error.message}`)
    const items = (data as unknown as BackfillInboxItem[] | null) ?? []
    if (items.length === 0) break
    totals.items += items.length

    const [whatsappRows, documentRows] = await Promise.all([
      readWhatsAppMessages(supabase, whatsappIdsToRead(items)),
      readDocuments(supabase, documentIdsToRead(items)),
    ])
    const { planned, skipped } = planArrivals(items, {
      whatsapp: new Map(whatsappRows.map((r) => [r.id, r])),
      documents: new Map(documentRows.map((r) => [r.id, r])),
    })

    for (const [reason, count] of Object.entries(skipped)) {
      totals.skipped.set(reason, (totals.skipped.get(reason) ?? 0) + (count ?? 0))
    }
    for (const arrival of planned) {
      // A delivery split across two pages counts once.
      if (!totals.deliveries.has(arrival.key)) {
        totals.deliveries.add(arrival.key)
        totals.bySource.set(arrival.source, (totals.bySource.get(arrival.source) ?? 0) + 1)
        if (arrival.originalRef) totals.withOriginal += 1
      }
      totals.outputs += arrival.outputs.length
      if (apply) await record(supabase, arrival, totals)
    }
    console.log(`  read ${totals.items} inbox items, ${totals.deliveries.size} deliveries so far`)
    if (items.length < pageSize) break
  }

  console.log('')
  console.log('Summary')
  console.log(`  inbox items read      : ${totals.items}`)
  console.log(`  deliveries (arrivals) : ${totals.deliveries.size}`)
  for (const [source, count] of [...totals.bySource.entries()].sort()) {
    console.log(`    ${source.padEnd(20)}: ${count}`)
  }
  console.log(`  with an original      : ${totals.withOriginal}`)
  console.log(`  outputs to link       : ${totals.outputs}`)
  console.log(`  items skipped         : ${[...totals.skipped.values()].reduce((a, b) => a + b, 0)}`)
  for (const [reason, count] of [...totals.skipped.entries()].sort()) {
    console.log(`    ${reason.padEnd(28)}: ${count}`)
  }
  if (apply) {
    console.log(`  arrivals created      : ${totals.created}`)
    console.log(`  already recorded      : ${totals.existing}`)
    console.log(`  failed                : ${totals.failed}`)
  } else {
    console.log('  DRY RUN: nothing was written. Re-run with --apply to record.')
  }
  if (totals.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
