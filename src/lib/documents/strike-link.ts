/**
 * A wrongly linked underlag: the link is struck, nothing moves, nothing is
 * deleted, and the right verifikat gets a copy.
 *
 * A document row keeps the verifikat it was linked to for good
 * (enforce_document_journal_entry_immutability) and a document on a posted
 * verifikat is never deleted (block_document_deletion, BFL 7 kap 2 §). An
 * underlag attached to the wrong verifikat is therefore corrected the way a
 * line is struck inside its verifikat, a rättelse of the verifikation
 * (BFL 5 kap 9 §; BFNAR 2013:2 punkt 5.15):
 *
 *   1. the right verifikat gets a byte-identical copy (linkDocumentCopyToVoucher:
 *      every link rule for that verifikat, the bytes checked against the
 *      source's SHA-256, idempotent per document and verifikat);
 *   2. the link on the wrong verifikat is struck on the document's own row:
 *      link_struck_at (when), link_struck_by (who), link_struck_reason (why)
 *      and link_struck_copy_id, set once.
 *
 * The copy comes first: when the strike fails after it (a lock taken in
 * between), the right verifikat already has its underlag and a second try
 * reuses the copy. The rules mirror enforce_document_link_strike (migration
 * 20261127160000), which stays the authority: the session's own user and the
 * database clock are what it writes, whatever the request sends, and a
 * strike that races past these checks is refused there.
 *
 * The window is the one of every rättelse in the same verifikat: a posted
 * verifikat whose date is in an open, unlocked period after the company's
 * lock date (resolvePeriodStatusForDate). A document a bank transaction or a
 * supplier invoice holds as its own underlag is changed through that register
 * and is refused here, as detach_underlag_duplicate refuses it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-status'
import { linkDocumentCopyToVoucher } from '@/lib/documents/link-document'

/** The longest reason the database takes (document_attachments_link_strike_check). */
export const STRIKE_REASON_MAX_LENGTH = 500

export interface StrikeLinkInput {
  document_id: string
  /** The verifikat the underlag belongs to: it gets a byte-identical copy. */
  journal_entry_id: string
  /** Why the link is struck, as the person writes it. */
  reason: string
}

export type StrikeLinkRefusalCode =
  | 'DOC_STRIKE_NOT_LINKED'
  | 'DOC_STRIKE_ALREADY_STRUCK'
  | 'DOC_STRIKE_NOT_CURRENT'
  | 'DOC_STRIKE_NOT_POSTED'
  | 'DOC_STRIKE_PERIOD_LOCKED'
  | 'DOC_STRIKE_PINNED_TRANSACTION'
  | 'DOC_STRIKE_PINNED_SUPPLIER_INVOICE'
  | 'DOC_STRIKE_SAME_VERIFIKAT'
  | 'DOC_STRIKE_TARGET_NOT_POSTED'
  | 'DOC_STRIKE_TARGET_PERIOD_LOCKED'
  | 'DOC_STRIKE_REASON_REQUIRED'
  | 'DOC_STRIKE_ACTOR_REQUIRED'
  | 'DOC_STRIKE_COPY_INVALID'

export type StrikeLinkRefusal =
  | { ok: false; code: 'NOT_FOUND'; resource: 'document' | 'journal_entry' }
  | { ok: false; code: StrikeLinkRefusalCode }

export interface StruckDocument {
  id: string
  file_name: string
  journal_entry_id: string
  link_struck_at: string
  link_struck_by: string
  link_struck_reason: string
  link_struck_copy_id: string | null
}

export type StrikeLinkResult =
  | {
      ok: true
      document: StruckDocument
      /** The copy the right verifikat holds now; reused when it already held these bytes. */
      copy: { id: string; journal_entry_id: string; reused: boolean }
    }
  | StrikeLinkRefusal

/** The trigger's refusals, by the code its message starts with: what changed since the checks above. */
const TRIGGER_REFUSALS: Readonly<Record<string, StrikeLinkRefusalCode>> = {
  DOC_STRIKE_PERMANENT: 'DOC_STRIKE_ALREADY_STRUCK',
  DOC_STRIKE_NOT_LINKED: 'DOC_STRIKE_NOT_LINKED',
  DOC_STRIKE_NOT_CURRENT: 'DOC_STRIKE_NOT_CURRENT',
  DOC_STRIKE_NOT_POSTED: 'DOC_STRIKE_NOT_POSTED',
  DOC_STRIKE_PERIOD_LOCKED: 'DOC_STRIKE_PERIOD_LOCKED',
  DOC_STRIKE_REASON_REQUIRED: 'DOC_STRIKE_REASON_REQUIRED',
  DOC_STRIKE_ACTOR_REQUIRED: 'DOC_STRIKE_ACTOR_REQUIRED',
  DOC_STRIKE_COPY_INVALID: 'DOC_STRIKE_COPY_INVALID',
}

/** The trigger's refusal of a strike, read from its message; null for any other failure. */
function triggerRefusal(message: string): StrikeLinkRefusalCode | null {
  const code = /\b(DOC_STRIKE_[A-Z_]+)\b/.exec(message)?.[1]
  if (!code) return null
  // One code for both registers; the message names which one holds it.
  if (code === 'DOC_STRIKE_PINNED') {
    return /supplier invoice/.test(message) ? 'DOC_STRIKE_PINNED_SUPPLIER_INVOICE' : 'DOC_STRIKE_PINNED_TRANSACTION'
  }
  return TRIGGER_REFUSALS[code] ?? null
}

/** `.maybeSingle()` found no row (PGRST116) or the id is no UUID (22P02): no row can match. */
function isLookupMiss(error: { code?: string | null } | null): boolean {
  return !error || error.code === 'PGRST116' || error.code === '22P02'
}

/**
 * Strike the link of `input.document_id` on the verifikat that holds it and
 * give `input.journal_entry_id` a copy. `userId` is the person: the uploader
 * of the copy, and who the strike names (the database takes the session's
 * user over it). Throws on a database failure; every rule answers a refusal.
 */
export async function strikeDocumentLink(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  input: StrikeLinkInput,
): Promise<StrikeLinkResult> {
  const reason = input.reason.trim()
  if (!reason) return { ok: false, code: 'DOC_STRIKE_REASON_REQUIRED' }

  const { data: docRow, error: docError } = await supabase
    .from('document_attachments')
    .select('id, journal_entry_id, is_current_version, link_struck_at')
    .eq('id', input.document_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!isLookupMiss(docError)) throw dbError(docError, 'document strike: document lookup failed')
  const doc = (docError ? null : docRow) as {
    id: string
    journal_entry_id: string | null
    is_current_version: boolean
    link_struck_at: string | null
  } | null
  if (!doc) return { ok: false, code: 'NOT_FOUND', resource: 'document' }
  if (!doc.journal_entry_id) return { ok: false, code: 'DOC_STRIKE_NOT_LINKED' }
  if (doc.link_struck_at) return { ok: false, code: 'DOC_STRIKE_ALREADY_STRUCK' }
  if (!doc.is_current_version) return { ok: false, code: 'DOC_STRIKE_NOT_CURRENT' }
  if (doc.journal_entry_id === input.journal_entry_id) return { ok: false, code: 'DOC_STRIKE_SAME_VERIFIKAT' }

  const [holderRes, targetRes, txPinRes, siPinRes] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('id, status, entry_date')
      .eq('id', doc.journal_entry_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('id, status')
      .eq('id', input.journal_entry_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase.from('transactions').select('id').eq('company_id', companyId).eq('document_id', doc.id).limit(1),
    supabase.from('supplier_invoices').select('id').eq('company_id', companyId).eq('document_id', doc.id).limit(1),
  ])
  if (!isLookupMiss(holderRes.error)) throw dbError(holderRes.error, 'document strike: verifikat lookup failed')
  if (!isLookupMiss(targetRes.error)) throw dbError(targetRes.error, 'document strike: target verifikat lookup failed')
  if (txPinRes.error) throw dbError(txPinRes.error, 'document strike: transaction pin lookup failed')
  if (siPinRes.error) throw dbError(siPinRes.error, 'document strike: supplier invoice lookup failed')

  const holder = (holderRes.error ? null : holderRes.data) as { id: string; status: string; entry_date: string } | null
  if (!holder || holder.status !== 'posted') return { ok: false, code: 'DOC_STRIKE_NOT_POSTED' }
  const target = (targetRes.error ? null : targetRes.data) as { id: string; status: string } | null
  if (!target) return { ok: false, code: 'NOT_FOUND', resource: 'journal_entry' }
  if (target.status !== 'posted') return { ok: false, code: 'DOC_STRIKE_TARGET_NOT_POSTED' }
  if (((txPinRes.data ?? []) as unknown[]).length > 0) return { ok: false, code: 'DOC_STRIKE_PINNED_TRANSACTION' }
  if (((siPinRes.data ?? []) as unknown[]).length > 0) return { ok: false, code: 'DOC_STRIKE_PINNED_SUPPLIER_INVOICE' }

  // Fails closed: a period that cannot be read is reported locked.
  const period = await resolvePeriodStatusForDate(supabase, companyId, holder.entry_date)
  if (period.status !== 'open') return { ok: false, code: 'DOC_STRIKE_PERIOD_LOCKED' }

  const copied = await linkDocumentCopyToVoucher(supabase, companyId, userId, {
    document_id: doc.id,
    journal_entry_id: target.id,
  })
  if (!copied.ok) {
    if (copied.code === 'PERIOD_LOCKED') return { ok: false, code: 'DOC_STRIKE_TARGET_PERIOD_LOCKED' }
    if (copied.code === 'NOT_FOUND') {
      return { ok: false, code: 'NOT_FOUND', resource: copied.details.resource === 'document' ? 'document' : 'journal_entry' }
    }
    // A copy never refuses for "held elsewhere", and no line was named.
    throw new Error(`document strike: unexpected copy refusal ${copied.code}`)
  }

  // The database writes who (the session's user) and when (its own clock);
  // the values here are what a caller without a session asks for.
  const { data: struck, error: strikeError } = await supabase
    .from('document_attachments')
    .update({
      link_struck_at: new Date().toISOString(),
      link_struck_by: userId,
      link_struck_reason: reason,
      link_struck_copy_id: copied.document.id,
    })
    .eq('id', doc.id)
    .eq('company_id', companyId)
    .is('link_struck_at', null)
    .select('id, file_name, journal_entry_id, link_struck_at, link_struck_by, link_struck_reason, link_struck_copy_id')
    .maybeSingle()
  if (strikeError) {
    const refusal = triggerRefusal(strikeError.message ?? '')
    if (refusal) return { ok: false, code: refusal }
    throw dbError(strikeError, 'document strike: update failed')
  }
  // Nothing matched the unstruck row: a strike made at the same moment won.
  if (!struck) return { ok: false, code: 'DOC_STRIKE_ALREADY_STRUCK' }

  return {
    ok: true,
    document: struck as StruckDocument,
    copy: { id: copied.document.id, journal_entry_id: target.id, reused: copied.reused },
  }
}
