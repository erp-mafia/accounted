#!/usr/bin/env npx tsx
/**
 * Backfill for inbox items stranded as "linked" on an already-booked
 * transaction (2026-08-12 report: booked verifikat stuck in "Att göra").
 *
 * The inbox list now derives "booked" from the matched transaction's own
 * state, so the DISPLAY heals by itself. What this script repairs is the
 * data left behind by the old write paths:
 *
 *   - document_attachments.journal_entry_id: the underlag of a matched item
 *     was never linked to the verifikat that booked its transaction
 *     (BFL 5 kap 6 §). Linked here unless the document is already anchored.
 *   - invoice_inbox_items.created_journal_entry_id: stamped where the UNIQUE
 *     constraint allows (on a samlingsverifikat only one of N items can
 *     carry it; the rest stay derived).
 *
 * Idempotent: items already stamped are excluded by the query, and the
 * propagation helper skips documents that are already anchored.
 *
 * Usage:
 *   npx tsx scripts/backfill-inbox-booked-underlag.ts              # dry-run (default)
 *   npx tsx scripts/backfill-inbox-booked-underlag.ts --execute    # apply
 *
 * DRY-RUN IS THE DEFAULT. Point NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY (.env.local) at staging first; prod only after
 * explicit confirmation.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  propagateUnderlagForBookedTransaction,
  resolveBookedJournalEntryIds,
} from '@/lib/transactions/inbox-underlag'

const EXECUTE = process.argv.includes('--execute')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

interface StrandedItem {
  id: string
  company_id: string
  matched_transaction_id: string
  document_id: string | null
}

async function main() {
  console.log(`Target: ${supabaseUrl}`)
  console.log(EXECUTE ? 'MODE: EXECUTE (writing)' : 'MODE: dry-run (no writes)')

  const items = await fetchAllRows<StrandedItem>((range) =>
    supabase
      .from('invoice_inbox_items')
      .select('id, company_id, matched_transaction_id, document_id')
      .not('matched_transaction_id', 'is', null)
      .is('created_journal_entry_id', null)
      .is('created_supplier_invoice_id', null)
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  console.log(`Matched, unconsumed inbox items: ${items.length}`)

  // Group per company so the resolver runs one batched lookup per tenant.
  const byCompany = new Map<string, StrandedItem[]>()
  for (const item of items) {
    const list = byCompany.get(item.company_id) ?? []
    list.push(item)
    byCompany.set(item.company_id, list)
  }

  let strandedOnBooked = 0
  let companiesTouched = 0
  for (const [companyId, companyItems] of byCompany) {
    const txIds = Array.from(new Set(companyItems.map((i) => i.matched_transaction_id)))
    const bookedByTx = await resolveBookedJournalEntryIds(supabase, companyId, txIds)
    const stranded = companyItems.filter((i) => bookedByTx.has(i.matched_transaction_id))
    if (stranded.length === 0) continue
    companiesTouched++
    strandedOnBooked += stranded.length
    console.log(`company ${companyId}: ${stranded.length} item(s) on booked transactions`)

    if (!EXECUTE) continue
    const txIdsToComplete = Array.from(new Set(stranded.map((i) => i.matched_transaction_id)))
    for (const txId of txIdsToComplete) {
      const journalEntryId = bookedByTx.get(txId)
      if (!journalEntryId) continue
      await propagateUnderlagForBookedTransaction(supabase, companyId, txId, journalEntryId)

      // Behandlingshistorik (BFNAR 2013:2 kap 8): a mass repair touching
      // underlag-to-verifikat linkage must leave a changelog trail
      // distinguishing it from the original booking action. Direct insert
      // mirroring lib/processing-history/append.ts (whose helper builds a
      // Next-bound service client this script cannot use); payload is
      // pseudonymous IDs only.
      const itemIds = stranded
        .filter((i) => i.matched_transaction_id === txId)
        .map((i) => i.id)
      const { error: historyError } = await supabase.from('processing_history').insert({
        event_id: crypto.randomUUID(),
        company_id: companyId,
        correlation_id: txId,
        causation_id: null,
        aggregate_type: 'BankTransaction',
        aggregate_id: txId,
        event_type: 'InboxUnderlagBackfilled',
        payload: {
          transaction_id: txId,
          journal_entry_id: journalEntryId,
          inbox_item_ids: itemIds,
          script: 'backfill-inbox-booked-underlag',
        },
        payload_schema_version: 1,
        actor: { type: 'system', id: 'backfill-inbox-booked-underlag' },
        rubric_version: null,
        occurred_at: new Date().toISOString(),
      })
      if (historyError) {
        console.error(
          `processing_history append failed for tx ${txId}: ${historyError.message}`,
        )
      }
    }
  }

  console.log(
    `${EXECUTE ? 'Repaired' : 'Would repair'} ${strandedOnBooked} item(s) across ${companiesTouched} company/companies.`,
  )
  if (!EXECUTE) console.log('Re-run with --execute to apply.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
