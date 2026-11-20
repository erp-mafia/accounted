import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { skvRequestWithAuth, SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'
import { auditUserIdFor } from '@/extensions/general/skatteverket/lib/audit'
import { markNeedsReconsent, RECONSENT_ERROR_CODES } from '@/extensions/general/skatteverket/lib/token-store'
import { sendKvittensNotification } from '@/extensions/general/skatteverket/lib/kvittens-notification'
import { resolveReadAuth } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { cronRunRaisesErrors } from '@/extensions/general/skatteverket/lib/cron-error-slot'
import { recordGrantRefusal } from '@/extensions/general/skatteverket/lib/grant-probe'
import { recordVatFilingConfirmed } from '@/lib/vat/filing-record-store'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { SkatteverketInlamnatResponse } from '@/extensions/general/skatteverket/types'
import type { VatPeriodType } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'
import { createLogger } from '@/lib/logger'
import { companyRedovisare } from '@/lib/company/org-number'
import { sameOrgNumber } from '@/lib/invariants/org-number'

export const maxDuration = 60

// The structured logger, not console: third-party error strings pass its
// redaction, and log.error is the level that reaches error tracking
// (accounted#115).
const log = createLogger('vat-kvittenser-cron')

/**
 * GET /api/extensions/skatteverket/vat/kvittenser/cron
 *
 * VAT filing reconciliation, mirroring the AGI kvittens cron. A locked VAT
 * draft (`submission_{period}` extension_data row with status
 * 'draft_locked') means the user was handed a BankID signing link at
 * Skatteverket. If they sign and never come back to the panel, nothing on
 * our side records that the declaration was filed: the submission state
 * stays "awaiting signature", the moms deadline stays open, and the user
 * gets no confirmation. This cron polls /inlamnat for those periods and on
 * a hit flips the stored state to 'signed', completes the period's moms
 * deadline, and emails the filing confirmation.
 *
 * Per-row errors are logged and skipped: one expired token must not block
 * other companies' reconciliation.
 */
export const GET = withCronContext('cron.skatteverket_vat_kvittenser', async () => {
  if (!isSkatteverketEnabled()) {
    return NextResponse.json({ message: 'Skatteverket extension disabled', processed: 0 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  // AGI submission state uses the distinct `agi_submission_` prefix, so the
  // `submission_` filter below cannot match AGI rows. Every row is read: the
  // status lives inside the stored JSON, so a window over all of them (it was
  // the oldest 200) fills up with signed and saved states, which are kept for
  // good, and a newly locked draft would never be looked at. The status
  // cannot be asked for in the query either: every writer stores the state
  // as JSON text inside the jsonb column (a jsonb string, not an object), so
  // `value->>status` is null for all of them.
  let rows: Array<{ id: string; company_id: string; key: string; value: unknown; updated_at: string | null }>
  try {
    rows = await fetchAllRows(({ from, to }) =>
      supabase
        .from('extension_data')
        .select('id, company_id, key, value, updated_at')
        .eq('extension_id', 'skatteverket')
        .like('key', 'submission\\_%')
        .order('id', { ascending: true })
        .range(from, to),
    )
  } catch (rowsError) {
    log.error('Failed to fetch submission states', {
      message: rowsError instanceof Error ? rowsError.message : String(rowsError),
    })
    return NextResponse.json({ error: 'Failed to fetch submission states' }, { status: 500 })
  }

  interface SubmissionState {
    status?: string
    redovisare?: string
    redovisningsperiod?: string
    periodType?: VatPeriodType
    year?: number
    period?: number
    signeringsLank?: string
    updatedAt?: string
  }

  const locked = rows.flatMap((row) => {
    try {
      const state: SubmissionState =
        typeof row.value === 'string' ? JSON.parse(row.value) : (row.value as SubmissionState)
      if (state?.status !== 'draft_locked' || !state.redovisare || !state.redovisningsperiod) {
        return []
      }
      return [{ id: row.id, companyId: row.company_id as string, key: row.key as string, state, readAt: row.updated_at ?? null }]
    } catch {
      return []
    }
  })

  if (locked.length === 0) {
    return NextResponse.json({ message: 'No locked drafts', processed: 0 })
  }

  // The run starts at a random point in id order and wraps round to the
  // start. It took the rows oldest updated_at first until the budget ran
  // out, and a declaration still waiting for its signature is never written,
  // so the same head was asked about on every run and a row behind it waited
  // until the head was signed. Ids are random (uuid), so every locked draft
  // has the same chance in every run, with nothing to store. The rows come in
  // id order (the query orders by id).
  const pivot = crypto.randomUUID()
  const start = locked.findIndex((item) => item.id > pivot)
  const ordered = start > 0 ? [...locked.slice(start), ...locked.slice(0, start)] : locked

  const startTime = Date.now()
  // The slowest row is a token refresh (10 s before it is given up), a second
  // look at the stored token after a refresh race (1 s), the Skatteverket
  // call (15 s), the writes and a mail: started at 30 s it still ends inside
  // the route's 60 s. At 50 s it could be cut off between the state write and
  // the mail.
  const TIME_BUDGET_MS = 30_000
  // The cron's schedule (vercel.json): every two hours, at half past.
  const CRON_INTERVAL_MS = 2 * 60 * 60 * 1000

  type Result = {
    companyId: string
    period: string
    status: 'signed' | 'still_pending' | 'state_changed' | 'no_token' | 'expired_token' | 'error'
    error?: string
  }
  const results: Result[] = []
  // Failures that were only ever returned in the response body, which nobody
  // reads: counted here and reported once after the loop, not per row per run.
  const unchecked = {
    /** Skatteverket answered the read with a failure, by HTTP status. */
    skatteverketErrors: {} as Record<string, number>,
    /** The system credential was refused for the company (OMBUD_GRANT_MISSING). */
    grantRefused: 0,
    /** Any other auth failure, by code. */
    authErrors: {} as Record<string, number>,
    /** Failures thrown on the way (network, timeout), by error name. */
    thrown: {} as Record<string, number>,
    companyIds: new Set<string>(),
  }
  const tally = (counts: Record<string, number>, key: string, companyId: string) => {
    counts[key] = (counts[key] ?? 0) + 1
    unchecked.companyIds.add(companyId)
  }
  // Auth outcomes that are a state of the connection, not a failure: the
  // user revoked the token at Skatteverket, or the row was being replaced by
  // a refresh in another job when it was read (the next run reads it whole).
  const QUIET_AUTH_CODES = new Set(['TOKEN_REVOKED', 'NOT_CONNECTED'])

  for (const item of ordered) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info('time budget reached', { rows: results.length })
      break
    }

    const { companyId, key, state, readAt } = item
    const period = state.redovisningsperiod as string

    if (!(await hasCapability(supabase, companyId, CAPABILITY.skatteverket))) {
      continue
    }

    try {
      // The company's own number, never the stored state's: extension_data
      // is writable by the company's members, and on Accounted's certificate
      // the number alone picks whose filing Skatteverket answers. A lock taken
      // for another number (changed since, or edited) is not checked.
      const redovisare = await companyRedovisare(supabase, companyId)
      if (!redovisare || !sameOrgNumber(redovisare, state.redovisare)) {
        log.warn('locked draft names another redovisare than the company; not checked', { companyId, key })
        results.push({ companyId, period, status: 'error', error: 'redovisare_mismatch' })
        continue
      }

      // Prefers system credentials (verified moms_ombud grant), falls back
      // to the company's user token: post-signing checks are exactly where
      // the 65-minute personal session is usually already dead.
      const resolved = await resolveReadAuth(supabase, companyId, { requires: 'moms_ombud' })
      if (!resolved.ok) {
        if (resolved.reason === 'needs_reconsent') {
          results.push({ companyId, period, status: 'expired_token', error: 'needs_reconsent' })
        } else {
          results.push({ companyId, period, status: 'no_token' })
        }
        continue
      }

      const response = await skvRequestWithAuth(
        resolved.auth,
        'GET',
        `/inlamnat/${redovisare}/${period}`,
        {
          endpoint: 'inlamnat',
          companyId,
          // Nobody asked: the token owner on a personal token, null on
          // system credentials. Never a stand-in user.
          userId: auditUserIdFor(resolved.auth),
          agRegistreradId: redovisare,
          redovisningsperiod: period,
          okStatuses: [404],
        }
      )

      if (response.status === 404) {
        results.push({ companyId, period, status: 'still_pending' })
        continue
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        tally(unchecked.skatteverketErrors, String(response.status), companyId)
        results.push({ companyId, period, status: 'error', error: `${response.status}: ${text}` })
        continue
      }

      const inlamnat = (await response.json()) as SkatteverketInlamnatResponse

      // Flip the stored state so the panel shows "inlämnad" instead of a
      // stale "awaiting signature" view. Keep the row (unlike AGI, the VAT
      // panel reads it for kvittens display on revisit).
      //
      // Compare-and-set on the row as this run read it (updated_at moves on
      // every write): the state written here is that snapshot with the status
      // changed, and the read is up to a run old. A write without the guard
      // put the old draft back over whatever the user or the panel's own
      // check had stored meanwhile (a new lock with a new signing link, the
      // signed state with its kvittens).
      const flip = supabase
        .from('extension_data')
        .update({
          value: JSON.stringify({
            ...state,
            status: 'signed',
            kvittensnummer: inlamnat.kvittensnummer ?? null,
            tidpunkt: inlamnat.tidpunkt ?? null,
            updatedAt: new Date().toISOString(),
          }),
        })
        .eq('company_id', companyId)
        .eq('extension_id', 'skatteverket')
        .eq('key', key)
      const { data: flipped, error: updateError } = await (readAt === null
        ? flip.is('updated_at', null)
        : flip.eq('updated_at', readAt)
      ).select('id')

      if (!updateError && (flipped ?? []).length === 0) {
        // Someone wrote the state after this run read it. Whoever did owns
        // it now (the panel's check records the filing itself): nothing is
        // completed or mailed from the old snapshot, and the next run reads
        // the row as it is.
        results.push({ companyId, period, status: 'state_changed' })
        continue
      }

      if (updateError) {
        // The row is still draft_locked, so the next run retries it. Skip
        // the deadline completion and the notification: doing them now
        // would double-fire when the retry succeeds.
        log.error('Failed to persist signed state', {
          companyId,
          period,
          message: updateError.message,
          code: updateError.code,
        })
        results.push({
          companyId,
          period,
          status: 'error',
          error: `Failed to persist signed state: ${getUserErrorMessage(updateError)}`,
        })
        continue
      }

      // Record the filing on the period's moms deadline. Only possible when
      // the state carries the picker params (written by the one-click chain;
      // states persisted by the older step-by-step routes lack them). One
      // path for every cadence: the store places a yearly period (year = the
      // year the räkenskapsår ends) from the company's fiscal-year settings.
      if (
        (state.periodType === 'monthly' ||
          state.periodType === 'quarterly' ||
          state.periodType === 'yearly') &&
        state.year &&
        state.period
      ) {
        // Creates the deadline row when the company has none for the
        // period (it predates the generator's window): a bare update would
        // leave no filing record and the VAT page would reopen the period.
        try {
          await recordVatFilingConfirmed(supabase, companyId, {
            periodType: state.periodType,
            year: Number(state.year),
            // A yearly period is always 1 in the key; the stored state's
            // period was never read for it, so it is not trusted now either.
            period: state.periodType === 'yearly' ? 1 : Number(state.period),
          })
        } catch (recordError) {
          log.error('Failed to record filing on the moms deadline', {
            companyId,
            period,
            message: recordError instanceof Error ? recordError.message : String(recordError),
          })
        }
      }

      if (resolved.tokenUserId) {
        await sendKvittensNotification(supabase, {
          companyId,
          userId: resolved.tokenUserId,
          kind: 'vat',
          period,
          kvittensnummer: inlamnat.kvittensnummer ?? period,
          referenceId: `vat_${companyId}_${period}`,
        })
      }

      results.push({ companyId, period, status: 'signed' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'

      if (err instanceof SkatteverketAuthError && err.code === 'OMBUD_GRANT_MISSING') {
        // System-mode read rejected: the ombudsregister decides whether the
        // grant is gone, and only then is the row downgraded so the next run
        // falls back to the user token (if any). Best-effort: a failure here
        // must not abort the remaining companies' rows.
        try {
          await recordGrantRefusal(companyId, 'moms_ombud')
        } catch (revokeErr) {
          log.warn('Failed to record the grant refusal', {
            companyId,
            period,
            message: revokeErr instanceof Error ? revokeErr.message : 'Unknown error',
          })
        }
        unchecked.grantRefused += 1
        unchecked.companyIds.add(companyId)
        results.push({ companyId, period, status: 'error', error: err.code })
        continue
      }

      if (
        err instanceof SkatteverketAuthError &&
        (RECONSENT_ERROR_CODES as readonly string[]).includes(err.code)
      ) {
        // Persist the health flag so the cron stops retrying this
        // connection. Best-effort: a failure here must not abort the
        // remaining companies' rows.
        try {
          // The verdict names the token it is about (a company can hold one
          // row per connected member), and the flag lands on that row only
          // while it is still that token: not on one another job stored.
          if (err.tokenRow) {
            await markNeedsReconsent(supabase, err.tokenRow.userId, companyId, err.code, err.tokenRow.version)
          }
        } catch (reconsentErr) {
          log.warn('Failed to persist reconsent flag', {
            companyId,
            period,
            message: reconsentErr instanceof Error ? reconsentErr.message : 'Unknown error',
          })
        }
        results.push({ companyId, period, status: 'expired_token', error: err.code })
        continue
      }
      if (err instanceof SkatteverketAuthError) {
        if (!QUIET_AUTH_CODES.has(err.code)) tally(unchecked.authErrors, err.code, companyId)
        results.push({ companyId, period, status: 'expired_token', error: err.code })
        continue
      }

      // Into the run's report (error level once per six hours), by name and
      // never by message; this line, with the message, is for whoever reads
      // the run's own log.
      log.warn('Reconciliation failed', { companyId, period, message })
      tally(unchecked.thrown, err instanceof Error ? err.name : 'unknown', companyId)
      results.push({ companyId, period, status: 'error', error: getUserErrorMessage(err) })
    }
  }

  const signed = results.filter((r) => r.status === 'signed').length
  const stillPending = results.filter((r) => r.status === 'still_pending').length
  const expired = results.filter((r) => r.status === 'expired_token').length
  const errors = results.filter((r) => r.status === 'error').length
  const stateChanged = results.filter((r) => r.status === 'state_changed').length

  if (unchecked.companyIds.size > 0) {
    // At error level once per six hours, warn otherwise: a declaration
    // Skatteverket keeps refusing stays locked, and is in every run until
    // someone looks (cron-error-slot.ts). The counts are in the summary below
    // on every run. The kinds (HTTP statuses, codes, error names, never
    // Skatteverket's text) are in the message, which is what error tracking
    // groups by: a new kind opens a group of its own.
    const kinds = [
      ...Object.keys(unchecked.skatteverketErrors).map((status) => `http_${status}`),
      ...(unchecked.grantRefused > 0 ? ['OMBUD_GRANT_MISSING'] : []),
      ...Object.keys(unchecked.authErrors),
      ...Object.keys(unchecked.thrown),
    ].sort()
    const message = `vat kvittens: filings could not be checked at Skatteverket (kinds: ${kinds.join(', ')})`
    const context = {
      skatteverketErrors: unchecked.skatteverketErrors,
      grantRefused: unchecked.grantRefused,
      authErrors: unchecked.authErrors,
      thrown: unchecked.thrown,
      companyIds: [...unchecked.companyIds].slice(0, 20),
    }
    if (cronRunRaisesErrors(startTime, CRON_INTERVAL_MS)) log.error(message, context)
    else log.warn(message, context)
  }

  log.info('vat kvittens reconciliation run', {
    processed: results.length,
    signed,
    stillPending,
    stateChanged,
    expired,
    errors,
    skatteverketErrors: unchecked.skatteverketErrors,
    grantRefused: unchecked.grantRefused,
    authErrors: unchecked.authErrors,
    thrown: unchecked.thrown,
  })

  return NextResponse.json({
    processed: results.length,
    signed,
    stillPending,
    expired,
    errors,
    results,
  })
})
