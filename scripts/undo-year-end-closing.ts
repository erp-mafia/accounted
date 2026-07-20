#!/usr/bin/env npx tsx
/**
 * Administrative undo of an executed year-end closing (bokslut).
 *
 * Restores a company to the state just before "Verkställ bokslut" so the
 * dispositions/preview step can be re-run, WITHOUT violating verifikat
 * immutability: every journal change is a storno posted through the
 * bookkeeping engine (BFL 5 kap 5 §). Nothing is edited or deleted.
 *
 * What it does, in order:
 *   1. Preconditions: the period has a closing entry; no årsredovisning
 *      submission or signature request exists for the company; the next
 *      period (if any) is open and has no closing entry of its own. Other
 *      posted entries in the next period are reported but do not block
 *      (their balances are independent of the IB; the re-run's continuity
 *      check revalidates everything).
 *   2. Reverse the next period's result_appropriation entry (2099 -> 2098).
 *   3. Reverse the next period's opening_balance entry. reverseEntry()
 *      itself clears opening_balance_entry_id + opening_balances_set on the
 *      period (two-step, per enforce_opening_balance_immutability).
 *   4. Reset the next period's continuity_verified to NULL.
 *   5. Reopen the closed period (is_closed=false, closed_at=null,
 *      locked_at=null).
 *   6. Reverse the closing entry (storno in the reopened period).
 *   7. Clear closing_entry_id. This must come AFTER the storno: the
 *      enforce_opening_balance_immutability trigger only allows detaching a
 *      closing entry that is reversed with a posted storno chain
 *      (migration 20260720140000).
 *   8. Write an explicit audit_log row (BFNAR 2013:2 kap. 8: reopening is a
 *      sensitive control change) and verify the final state.
 *
 * RESUMABLE: every step is idempotent-or-skipped, so if a run dies midway
 * (e.g. after the reopen but before the detach) simply re-run with the same
 * arguments: already-reversed entries are skipped, the reopen is skipped
 * when the period is already open, and the run continues from the first
 * incomplete step.
 *
 * Dispositions already booked in the period (periodiseringsfond, SLP,
 * överavskrivningar) are NOT touched: only the closing entry and the two
 * auto-generated new-year entries are reversed.
 *
 * Attribution (BFL 5 kap 6 §): pass --user-id to attribute the stornos
 * explicitly (normally the company owner who requested the reset); defaults
 * to the company owner, with a loud warning on the arbitrary-member fallback.
 *
 * Usage:
 *   # Dry run (read-only) against the env in .env.local
 *   npx tsx scripts/undo-year-end-closing.ts --company-id <uuid> --period-id <uuid>
 *
 *   # Apply, attributing to a specific user. --confirm-url must restate the
 *   # target Supabase URL so the operator confirms WHICH environment mutates.
 *   npx tsx scripts/undo-year-end-closing.ts --company-id <uuid> --period-id <uuid> \
 *     --user-id <uuid> --commit --confirm-url https://<project>.supabase.co
 *
 *   # Against another environment (e.g. production)
 *   npx tsx scripts/undo-year-end-closing.ts --env-file .env.prod.local ...
 *
 * Run against staging first; only run against prod after reviewing the dry-run.
 */

import { config } from 'dotenv'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

config({ path: arg('env-file') ?? '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { reverseEntry } from '../lib/bookkeeping/engine'

const COMPANY_ID = arg('company-id')
const PERIOD_ID = arg('period-id')
const USER_ID_ARG = arg('user-id')
const COMMIT = process.argv.includes('--commit')
const CONFIRM_URL = arg('confirm-url')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!serviceKey.startsWith('eyJ') && !serviceKey.startsWith('sb_secret_')) {
  console.error(
    'SUPABASE_SERVICE_ROLE_KEY does not look like a service-role key (expected a JWT or sb_secret_ prefix); check the env file'
  )
  process.exit(1)
}
if (!COMPANY_ID || !PERIOD_ID) {
  console.error(
    'Usage: --company-id <uuid> --period-id <uuid> [--user-id <uuid>] [--env-file <path>] [--commit --confirm-url <supabase-url>]'
  )
  process.exit(1)
}
// A prefix check on the key cannot catch a right-looking key from the WRONG
// environment (e.g. a staging env file against prod). For mutations, the
// operator must restate the target URL so an accidental env swap fails loud.
if (COMMIT && CONFIRM_URL !== url) {
  console.error(
    `--commit requires --confirm-url to exactly match the target Supabase URL.\n` +
      `  target:      ${url}\n` +
      `  confirm-url: ${CONFIRM_URL ?? '(missing)'}`
  )
  process.exit(1)
}

const supabase: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false },
})

function fail(msg: string): never {
  console.error(`BLOCKED: ${msg}`)
  process.exit(1)
}

type EntryRow = {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  source_type: string
  status: string
}

function label(e: EntryRow): string {
  return `${e.voucher_series ?? 'A'}${e.voucher_number} ${e.entry_date} "${e.description}" [${e.source_type}/${e.status}]`
}

async function main() {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'dry-run'}   target: ${url}`)

  // ── Load period ────────────────────────────────────────────────
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', PERIOD_ID)
    .eq('company_id', COMPANY_ID)
    .single()
  if (periodError || !period) fail(`fiscal period not found: ${periodError?.message}`)

  console.log(`Period: ${period.name} (${period.period_start} - ${period.period_end})`)
  if (!period.closing_entry_id) fail('period has no closing_entry_id: nothing to undo')
  if (!period.is_closed) {
    console.warn('  note: period is not closed (resuming a partial undo, or year-end failed midway)')
  }

  // ── Preconditions ──────────────────────────────────────────────
  const { count: submissions } = await supabase
    .from('arsredovisning_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', COMPANY_ID)
    .eq('fiscal_period_id', PERIOD_ID)
  if ((submissions ?? 0) > 0) fail('an årsredovisning submission exists for this period: refuse to reopen')

  const { count: signatureRequests } = await supabase
    .from('arsredovisning_signature_requests')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', COMPANY_ID)
    .eq('fiscal_period_id', PERIOD_ID)
  if ((signatureRequests ?? 0) > 0) fail('an årsredovisning signature request exists for this period: refuse to reopen')

  const { data: settings } = await supabase
    .from('company_settings')
    .select('bookkeeping_locked_through')
    .eq('company_id', COMPANY_ID)
    .maybeSingle()
  if (
    settings?.bookkeeping_locked_through &&
    settings.bookkeeping_locked_through >= period.period_end
  ) {
    fail(
      `company lock date ${settings.bookkeeping_locked_through} covers the period end: clear it first`
    )
  }

  const { data: closingEntry } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, entry_date, description, source_type, status')
    .eq('id', period.closing_entry_id)
    .eq('company_id', COMPANY_ID)
    .single()
  if (!closingEntry) fail('closing entry row not found')
  if (closingEntry.status !== 'posted' && closingEntry.status !== 'reversed') {
    fail(`closing entry has unexpected status (${closingEntry.status})`)
  }
  console.log(`Closing entry: ${label(closingEntry)}`)

  // ── Next period + its auto-generated entries ───────────────────
  // Chain lookup first, then date-based fallback (day after period_end),
  // mirroring findNextPeriod() in period-service: periods created before the
  // previous_period_id chain was wired up must still be found, or their
  // IB/appropriation entries would be left posted and block the re-run.
  let { data: nextPeriod } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', COMPANY_ID)
    .eq('previous_period_id', PERIOD_ID)
    .maybeSingle()

  if (!nextPeriod) {
    const dayAfter = new Date(period.period_end + 'T00:00:00Z')
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1)
    const { data: byDate } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('company_id', COMPANY_ID)
      .eq('period_start', dayAfter.toISOString().slice(0, 10))
      .maybeSingle()
    nextPeriod = byDate
  }

  let ibEntry: EntryRow | null = null
  let appropriationEntry: EntryRow | null = null

  if (nextPeriod) {
    console.log(`Next period: ${nextPeriod.name} (${nextPeriod.period_start} - ${nextPeriod.period_end})`)
    if (nextPeriod.is_closed || nextPeriod.closing_entry_id) {
      fail('next period is itself closed: undo that year first')
    }
    if (nextPeriod.locked_at) fail('next period is locked: unlock it first')

    const { data: nextEntries } = await supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, entry_date, description, source_type, status')
      .eq('company_id', COMPANY_ID)
      .eq('fiscal_period_id', nextPeriod.id)
      .neq('status', 'cancelled')
      .order('voucher_number', { ascending: true })

    for (const e of (nextEntries ?? []) as EntryRow[]) {
      if (e.status !== 'posted') continue
      // The IB entry is matched by the period's own link when set; the
      // source_type scan is the fallback for a partial run where the link
      // was already cleared but a posted IB somehow remains.
      if (
        e.source_type === 'opening_balance' &&
        (!nextPeriod.opening_balance_entry_id || e.id === nextPeriod.opening_balance_entry_id)
      ) {
        ibEntry = e
      } else if (e.source_type === 'result_appropriation') {
        appropriationEntry = e
      } else {
        // Real bookkeeping already exists in the new year. That is fine for
        // the reset itself (their balances are independent of the IB), but
        // say so loudly so the operator has thought about it.
        console.warn(`  note: next period has other posted entries, e.g. ${label(e)}`)
      }
    }
    if (ibEntry) console.log(`Opening balance entry: ${label(ibEntry)}`)
    if (appropriationEntry) console.log(`Result appropriation entry: ${label(appropriationEntry)}`)
  } else {
    console.log('No next period found: only the closing entry will be reversed')
  }

  // ── Attribution ────────────────────────────────────────────────
  let userId = USER_ID_ARG
  if (!userId) {
    const { data: owner } = await supabase
      .from('company_members')
      .select('user_id, role')
      .eq('company_id', COMPANY_ID)
      .eq('role', 'owner')
      .limit(1)
      .maybeSingle()
    if (owner) {
      userId = owner.user_id
    } else {
      const { data: anyMember } = await supabase
        .from('company_members')
        .select('user_id')
        .eq('company_id', COMPANY_ID)
        .limit(1)
        .maybeSingle()
      if (!anyMember) fail('no company member to attribute the stornos to')
      userId = anyMember.user_id
      console.warn('WARNING: no owner found; attributing to an arbitrary member. Pass --user-id.')
    }
  }
  console.log(`Attribution user: ${userId}`)

  if (!COMMIT) {
    console.log('\nDry run only. Planned actions:')
    if (appropriationEntry) console.log(`  1. Storno ${label(appropriationEntry)}`)
    if (ibEntry) console.log(`  2. Storno ${label(ibEntry)} (clears IB link + flag on next period)`)
    if (nextPeriod) console.log('  3. Reset next period continuity_verified to NULL')
    if (period.is_closed || period.locked_at) {
      console.log(`  4. Reopen ${period.name}: is_closed=false, closed_at=null, locked_at=null`)
    }
    if (closingEntry.status === 'posted') console.log(`  5. Storno ${label(closingEntry)}`)
    console.log('  6. Clear closing_entry_id on the reopened period (+ audit_log)')
    console.log('Re-run with --commit to apply.')
    return
  }

  // ── Execute ────────────────────────────────────────────────────
  if (appropriationEntry) {
    console.log('Reversing result appropriation entry…')
    const storno = await reverseEntry(supabase, COMPANY_ID!, userId!, appropriationEntry.id)
    console.log(`  posted storno ${storno.voucher_series}${storno.voucher_number}`)
  }

  if (ibEntry) {
    console.log('Reversing opening balance entry…')
    const storno = await reverseEntry(supabase, COMPANY_ID!, userId!, ibEntry.id)
    console.log(`  posted storno ${storno.voucher_series}${storno.voucher_number}`)
  }

  if (nextPeriod) {
    const { error: contError } = await supabase
      .from('fiscal_periods')
      .update({ continuity_verified: null })
      .eq('id', nextPeriod.id)
      .eq('company_id', COMPANY_ID)
    if (contError) fail(`failed to reset continuity_verified: ${contError.message}`)
  }

  if (period.is_closed || period.locked_at) {
    console.log('Reopening the closed period…')
    // closing_entry_id is NOT cleared here: the immutability trigger only
    // allows detaching a closing entry that is already storno-reversed, so
    // the link is cleared after the storno below.
    const { error: reopenError } = await supabase
      .from('fiscal_periods')
      .update({
        is_closed: false,
        closed_at: null,
        locked_at: null,
      })
      .eq('id', PERIOD_ID)
      .eq('company_id', COMPANY_ID)
    if (reopenError) fail(`failed to reopen period: ${reopenError.message}`)
  } else {
    console.log('Period already open (resume): skipping reopen')
  }

  let closingStornoLabel = 'already reversed (resume)'
  if (closingEntry.status === 'posted') {
    console.log('Reversing closing entry…')
    const closingStorno = await reverseEntry(supabase, COMPANY_ID!, userId!, closingEntry.id)
    closingStornoLabel = `${closingStorno.voucher_series}${closingStorno.voucher_number}`
    console.log(`  posted storno ${closingStornoLabel}`)
  } else {
    console.log('Closing entry already reversed (resume): skipping storno')
  }

  console.log('Detaching closing entry from the period…')
  const { error: detachError } = await supabase
    .from('fiscal_periods')
    .update({ closing_entry_id: null })
    .eq('id', PERIOD_ID)
    .eq('company_id', COMPANY_ID)
  if (detachError) fail(`failed to clear closing_entry_id: ${detachError.message}`)

  // Audit trail AFTER the mutations so the row describes what actually
  // happened (BFNAR 2013:2 kap. 8 behandlingshistorik). The automatic
  // write_audit_log trigger also recorded each UPDATE individually.
  const auditRow = {
    user_id: userId,
    company_id: COMPANY_ID,
    action: 'UPDATE',
    table_name: 'fiscal_periods',
    record_id: PERIOD_ID,
    description:
      `Administrative year-end undo: period reopened (${period.name}, ${period.period_start} to ${period.period_end}); ` +
      `closing entry ${closingEntry.voucher_series ?? 'A'}${closingEntry.voucher_number} reversed by storno ${closingStornoLabel} ` +
      'and detached; auto-generated new-year entries reversed on user request.',
    old_state: {
      is_closed: period.is_closed,
      closed_at: period.closed_at,
      locked_at: period.locked_at,
      closing_entry_id: period.closing_entry_id,
    },
    new_state: { is_closed: false, closed_at: null, locked_at: null, closing_entry_id: null },
  }
  // BFNAR 2013:2 kap. 8: the behandlingshistorik row is part of the undo.
  // The mutations cannot be rolled back from here (each already committed via
  // PostgREST), so retry the insert before giving up.
  let auditError: { message: string } | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { error } = await supabase.from('audit_log').insert(auditRow)
    auditError = error
    if (!auditError) break
    console.warn(`  audit_log insert attempt ${attempt}/3 failed: ${auditError.message}`)
  }
  if (auditError) {
    fail(
      `audit_log insert failed after 3 attempts: ${auditError.message}\n` +
        'The period state itself is valid (all mutations completed), but the undo is NOT ' +
        'complete until the behandlingshistorik row exists (BFNAR 2013:2 kap. 8). ' +
        'Insert the audit_log row manually (see auditRow in this script for the exact ' +
        'content) before treating the undo as done.'
    )
  }

  // ── Verify ─────────────────────────────────────────────────────
  const { data: closingAfter } = await supabase
    .from('journal_entries')
    .select('status')
    .eq('id', closingEntry.id)
    .eq('company_id', COMPANY_ID)
    .single()
  const { data: periodAfter } = await supabase
    .from('fiscal_periods')
    .select('is_closed, locked_at, closing_entry_id')
    .eq('id', PERIOD_ID)
    .eq('company_id', COMPANY_ID)
    .single()
  const { data: nextAfter } = nextPeriod
    ? await supabase
        .from('fiscal_periods')
        .select('opening_balance_entry_id, opening_balances_set, continuity_verified')
        .eq('id', nextPeriod.id)
        .eq('company_id', COMPANY_ID)
        .single()
    : { data: null }

  const ok =
    closingAfter?.status === 'reversed' &&
    periodAfter?.is_closed === false &&
    periodAfter?.locked_at === null &&
    periodAfter?.closing_entry_id === null &&
    (!nextPeriod ||
      (nextAfter?.opening_balance_entry_id === null && nextAfter?.opening_balances_set === false))

  if (!ok) {
    console.error('VERIFICATION FAILED: inspect state manually', {
      closingAfter,
      periodAfter,
      nextAfter,
    })
    process.exit(1)
  }

  console.log('\nDone. The period is open again; the dispositions/preview step can be re-run.')
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
