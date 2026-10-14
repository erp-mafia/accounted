/**
 * The daily look at every company's verification (know your customer) at the
 * payment provider: the renewal nudge's source.
 *
 * Runs inside the payment status cron (every 15 minutes) and refreshes the
 * records nobody has asked about for a day, a bounded number per run, so a
 * company that verified once and then paid without opening the dialog still
 * gets a fresh valid_until on file. The worklist (lib/worklist, category
 * payments_verification_renewal) derives its "Förnya verifieringen för
 * betalningar" row from that record: once valid_until is within 30 days the
 * row appears, and it leaves when the renewal lands. Nothing is mailed: no
 * template exists for a provider-side renewal, and the Att göra row is the
 * channel every other renewal (bank consent aside) uses.
 *
 * A company whose payments door is closed (plan lapsed, pilot narrowed) is
 * skipped, not refreshed: the record keeps its last answer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { hasPaymentInitiationProviders, PaymentProviderError } from '@/lib/payments/initiation/provider'
import { companyParty, refreshCompanyVerification } from './availability'
import { openPaymentsDoor } from './switched-on'
import { readVerificationRecord, VERIFICATION_RECORD_COLUMNS, VERIFICATION_TABLE, type VerificationRecord } from './verification-record'
import { deriveVerificationState, RENEWAL_DUE_STATES } from './verification-state'

/** A record checked more recently than this is left alone. */
export const VERIFICATION_SWEEP_AFTER_MS = 24 * 60 * 60 * 1000
/** Records refreshed per run; the oldest answers first, so nothing starves. */
export const VERIFICATION_SWEEP_LIMIT = 50

export interface VerificationSweepResult {
  /** Records older than a day that were considered. */
  considered: number
  /** Provider answers written. */
  refreshed: number
  /** Companies whose verification is expiring or expired after the refresh: the worklist row shows. */
  renewalDue: number
  skipped: { doorClosed: number; noOrgNumber: number }
  errors: number
  /** True when no payments provider is registered: nothing was asked. */
  noProvider?: boolean
}

export async function sweepPaymentVerifications(writer: SupabaseClient, log: Logger, now: Date = new Date()): Promise<VerificationSweepResult> {
  const result: VerificationSweepResult = { considered: 0, refreshed: 0, renewalDue: 0, skipped: { doorClosed: 0, noOrgNumber: 0 }, errors: 0 }
  if (!(await hasPaymentInitiationProviders())) return { ...result, noProvider: true }

  const before = new Date(now.getTime() - VERIFICATION_SWEEP_AFTER_MS).toISOString()
  const { data, error } = await writer
    .from(VERIFICATION_TABLE)
    .select(VERIFICATION_RECORD_COLUMNS)
    .or(`checked_at.is.null,checked_at.lt.${before}`)
    .order('checked_at', { ascending: true, nullsFirst: true })
    .limit(VERIFICATION_SWEEP_LIMIT)
  if (error) throw error
  const records = (data ?? []) as VerificationRecord[]

  for (const record of records) {
    result.considered += 1
    try {
      const door = await openPaymentsDoor({ supabase: writer, companyId: record.company_id })
      if (!door.ok) {
        result.skipped.doorClosed += 1
        continue
      }
      const party = await companyParty({ supabase: writer, companyId: record.company_id })
      if (!party) {
        result.skipped.noOrgNumber += 1
        continue
      }
      await refreshCompanyVerification(writer, door.provider, party, now)
      result.refreshed += 1
      const fresh = await readVerificationRecord(writer, record.company_id)
      if (RENEWAL_DUE_STATES.has(deriveVerificationState(fresh, now).state)) result.renewalDue += 1
    } catch (err) {
      result.errors += 1
      log.warn('payments verification sweep failed for one company', {
        companyId: record.company_id,
        code: err instanceof PaymentProviderError ? err.code : 'UNEXPECTED_ERROR',
      })
    }
  }
  return result
}
