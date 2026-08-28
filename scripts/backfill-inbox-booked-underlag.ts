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
 * Since #1548 the same pass runs daily from
 * app/api/extensions/invoice-inbox/underlag-reconcile/cron; this script is
 * the manual, uncapped entry point to the shared implementation in
 * lib/transactions/inbox-underlag-reconcile.ts (dry-run, or a full sweep
 * after an incident). Idempotent: items already stamped are excluded by the
 * query, and the propagation helper skips documents that are already
 * anchored.
 *
 * Usage:
 *   npx tsx scripts/backfill-inbox-booked-underlag.ts              # dry-run (default)
 *   npx tsx scripts/backfill-inbox-booked-underlag.ts --execute    # apply
 *
 * DRY-RUN IS THE DEFAULT. Point NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY (.env.local) at staging first; prod only after
 * explicit confirmation.
 *
 * Period locks: the document link goes through linkToJournalEntry, whose
 * document_attachments.journal_entry_id UPDATE is guarded by the
 * enforce_period_lock DB trigger. Table triggers fire for service-role
 * writes too (service role bypasses RLS, never triggers), so a locked
 * period fails that item with a logged error instead of writing into it.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { reconcileStrandedInboxUnderlag } from '@/lib/transactions/inbox-underlag-reconcile'

const EXECUTE = process.argv.includes('--execute')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey)

async function main() {
  console.log(`Target: ${supabaseUrl}`)
  console.log(EXECUTE ? 'MODE: EXECUTE (writing)' : 'MODE: dry-run (no writes)')

  // Uncapped: the cron is bounded per run, a manual sweep is not.
  const summary = await reconcileStrandedInboxUnderlag(supabase, {
    execute: EXECUTE,
    maxItems: Number.POSITIVE_INFINITY,
    actorId: 'backfill-inbox-booked-underlag',
  })

  console.log(`Matched, unconsumed inbox items: ${summary.scanned}`)
  console.log(JSON.stringify(summary, null, 2))
  console.log(
    EXECUTE
      ? `Repaired ${summary.repaired} item(s) across ${summary.companiesTouched} company/companies; ` +
          `${summary.stillUnlinked} still unlinked, ${summary.anchoredElsewhere} anchored elsewhere.`
      : `Would link ${summary.stillUnlinked} item(s) across ${summary.companiesTouched} company/companies; ` +
          `${summary.anchoredElsewhere} anchored elsewhere need a human.`,
  )
  if (!EXECUTE) console.log('Re-run with --execute to apply.')
  if (summary.failures > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
