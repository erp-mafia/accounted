/**
 * The stored verification record (company_payment_verifications): what the
 * provider last answered about the company and the current form link. Every
 * provider answer is written here (availability.ts and the cron sweep), so
 * readers that must not call the provider (the worklist, the signing link
 * door) can still say where the company stands.
 *
 * The form URL is the sensitive column: the browser session has no grant on
 * it, this module never selects it, and nothing here logs it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  deriveVerificationState,
  FORM_OUT_STATES,
  verificationLinkExpiresAt,
  type ProviderVerificationStatus,
  type VerificationRecordLike,
} from './verification-state'

export const VERIFICATION_TABLE = 'company_payment_verifications'

/** Never link_url. */
export const VERIFICATION_RECORD_COLUMNS = 'company_id, status, valid_until, checked_at, link_created_at, link_expires_at, handed_off_at, started_by, updated_at'

/** A stored answer older than this is asked again on the next read that cares. */
export const VERIFICATION_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000

export interface VerificationRecord extends VerificationRecordLike {
  company_id: string
  checked_at: string | null
  started_by: string | null
  updated_at: string
}

export async function readVerificationRecord(client: SupabaseClient, companyId: string): Promise<VerificationRecord | null> {
  const { data, error } = await client.from(VERIFICATION_TABLE).select(VERIFICATION_RECORD_COLUMNS).eq('company_id', companyId).maybeSingle()
  if (error) throw error
  return (data as VerificationRecord | null) ?? null
}

/**
 * Whether the provider should be asked: the caller asks, nothing is on file,
 * the answer is older than VERIFICATION_REFRESH_AFTER_MS, or a form is out
 * (a person may have just signed it, and the answer is what they wait for).
 */
export function verificationNeedsRefresh(record: VerificationRecord | null, now: Date = new Date(), force = false): boolean {
  if (force || !record || !record.checked_at) return true
  if (now.getTime() - new Date(record.checked_at).getTime() >= VERIFICATION_REFRESH_AFTER_MS) return true
  return FORM_OUT_STATES.has(deriveVerificationState(record, now).state)
}

export interface VerificationCheck {
  status: ProviderVerificationStatus
  validUntil: string | null
  checkedAt: Date
}

/** Store what the provider answered. Insert or update; the link columns are left as they are. */
export async function recordVerificationCheck(writer: SupabaseClient, companyId: string, check: VerificationCheck): Promise<void> {
  const { error } = await writer.from(VERIFICATION_TABLE).upsert(
    {
      company_id: companyId,
      status: check.status,
      valid_until: check.validUntil,
      checked_at: check.checkedAt.toISOString(),
    },
    { onConflict: 'company_id' },
  )
  if (error) throw error
}

export interface VerificationLink {
  url: string
  createdAt: Date
  startedBy: string | null
  /** The form goes to a firmatecknare (mailed or copied for them) rather than being opened here. */
  handedOff: boolean
}

/**
 * Store a form link just created at the provider. A new link is a new form:
 * the hand-off mark follows this link, never an earlier one.
 */
export async function recordVerificationLink(writer: SupabaseClient, companyId: string, link: VerificationLink): Promise<{ expiresAt: string }> {
  const expiresAt = verificationLinkExpiresAt(link.createdAt)
  const { error } = await writer.from(VERIFICATION_TABLE).upsert(
    {
      company_id: companyId,
      link_url: link.url,
      link_created_at: link.createdAt.toISOString(),
      link_expires_at: expiresAt,
      handed_off_at: link.handedOff ? link.createdAt.toISOString() : null,
      started_by: link.startedBy,
    },
    { onConflict: 'company_id' },
  )
  if (error) throw error
  return { expiresAt }
}
