/**
 * The batched attest mail's link: one mail to an attester lists every
 * invoice waiting on them in one company, and its button opens
 * /attest/lista/<token>, where they approve them all or reject one, without
 * logging in.
 *
 * The token is a credential like the single invoice's link (attest-links.ts):
 * 32 random bytes, sha256-hashed at rest, valid 7 days, bound to one attester
 * and to the invoices the mail listed. Unlike that link it is not spent by
 * the first decision: it works until every listed invoice is answered (or
 * has left attest), and is then consumed. A rejection by anyone after the
 * mail went out closes that invoice for the link, as it spends every
 * single-invoice link of the invoice (attest-batch-route.ts reads it).
 *
 * One row per mail, stored and leased before the mail is sent
 * (storeAttestBatches). Right before the mail is handed to the provider the
 * row is marked sent (takeAttestBatchSend), so a run that dies mid-send, or
 * a send that may have gone out, never leads to a second mail. Only a
 * definite refusal clears the mark again (giveBackAttestBatch), and a later
 * run tries the same row (leaseAttestBatchRetry): one conditional update
 * gives it a fresh token and a new lease, so a retry and the old link never
 * both exist. At most ATTEST_SEND_MAX_ATTEMPTS tries, within
 * ATTEST_RESEND_WINDOW_MS of the first.
 *
 * Deploy order: Vercel ships code on merge while prod migrations can lag
 * (code-before-migration-gap). Until supplier_invoice_attest_mail_state
 * exists, a registration falls back to the single-invoice mail
 * (attest-notify.ts), the jobs skip and every batch link reads as unknown.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateInviteToken, hashInviteToken, isValidInviteTokenFormat } from '@/lib/bank-feed/invites'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'

export const ATTEST_BATCH_TTL_DAYS = 7
/** The most invoices one mail lists; a larger round goes out as several mails. */
export const ATTEST_BATCH_MAX_INVOICES = 100

export type AttestBatchKind = 'request' | 'reminder'

export interface AttestBatchRow {
  id: string
  company_id: string
  attester_user_id: string
  kind: AttestBatchKind
  invoice_ids: string[]
  expires_at: string
  mail_sent_at: string | null
  consumed_at: string | null
  created_at: string
}


/** The page the mail's button opens: `<base>/attest/lista/<token>`. */
export function attestBatchUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/attest/lista/${token}`
}

export function attestBatchExpiresAt(now: number = Date.now()): string {
  return new Date(now + ATTEST_BATCH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/** How long a run holds a mail it is sending; a lapsed lease means the run died. */
export const ATTEST_SEND_LEASE_MS = 15 * 60_000
/** send_lease_until of a row no run holds: earlier than any now, so a free row is simply send_lease_until < now. */
export const ATTEST_NOT_LEASED = '-infinity'
/** Tries at one mail, the first included: a mail the provider keeps refusing stops. */
export const ATTEST_SEND_MAX_ATTEMPTS = 6
/** A mail that would not go is tried again for this long after its row was stored. */
export const ATTEST_RESEND_WINDOW_MS = 24 * 60 * 60_000
/**
 * How long a refused mail waits before its next try, by the try that was
 * refused: the tries spread over the day, so a rate limit or a quota stop
 * that lasts hours does not use them all up in half an hour.
 */
export const ATTEST_RETRY_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000] as const

/** The wait after try `attempt` (1-based) was refused. */
export function attestRetryBackoffMs(attempt: number): number {
  return ATTEST_RETRY_BACKOFF_MS[Math.min(Math.max(attempt, 1), ATTEST_RETRY_BACKOFF_MS.length) - 1]!
}

/** One mail to store: an attester and the invoices it lists. */
export interface AttestBatchIntent {
  attesterUserId: string
  kind: AttestBatchKind
  invoiceIds: string[]
}

/** A mail this run holds the lease on, with the clear token of its current try. */
export interface StoredAttestBatch {
  batch_id: string
  attesterUserId: string
  kind: AttestBatchKind
  invoiceIds: string[]
  /** The clear token. Only the URL and the mail carry it; never store or log it. */
  token: string
  expires_at: string
  /** The lease this run holds: the row is released or finished only under it. */
  lease_until: string
  /** Which try this is (send_attempts): the first is 1. */
  attempt: number
}

function leaseUntil(now: number): string {
  return new Date(now + ATTEST_SEND_LEASE_MS).toISOString()
}

/**
 * Storing a round's links failed. `retired`: whatever the insert may have
 * written (its reply can be lost after it committed) is retired by token
 * hash, so none of it can be sent and the caller may give its claims back.
 * Not retired: the caller keeps its claims, or the rows and a re-claimed
 * round could both be mailed.
 */
export class AttestBatchStoreError extends Error {
  readonly retired: boolean
  readonly reason: unknown
  constructor(retired: boolean, reason: unknown) {
    super(`Attest batches not stored${retired ? '' : ', and not retired'}`)
    this.name = 'AttestBatchStoreError'
    this.retired = retired
    this.reason = reason
  }
}

/**
 * Store the links of one company's mails in ONE insert, leased to this run,
 * before any of them is sent: either every mail of the round is on record
 * (and one that does not go is tried again later) or none is, and nothing
 * went out. On a failure it throws AttestBatchStoreError.
 */
export async function storeAttestBatches(
  service: SupabaseClient,
  companyId: string,
  intents: readonly AttestBatchIntent[],
  options: { now?: number } = {},
): Promise<StoredAttestBatch[]> {
  if (intents.length === 0) return []
  const now = options.now ?? Date.now()
  const expiresAt = attestBatchExpiresAt(now)
  const lease = leaseUntil(now)
  const rows = intents.map((intent) => {
    const invoiceIds = [...new Set(intent.invoiceIds)]
    if (invoiceIds.length === 0 || invoiceIds.length > ATTEST_BATCH_MAX_INVOICES) {
      throw new Error(`An attest batch lists 1 to ${ATTEST_BATCH_MAX_INVOICES} invoices, not ${invoiceIds.length}`)
    }
    const { token, hash } = generateInviteToken()
    return { intent: { ...intent, invoiceIds }, token, hash }
  })
  const { data, error } = await service
    .from('supplier_invoice_attest_batches')
    .insert(
      rows.map(({ intent, hash }) => ({
        company_id: companyId,
        attester_user_id: intent.attesterUserId,
        kind: intent.kind,
        invoice_ids: intent.invoiceIds,
        token_hash: hash,
        expires_at: expiresAt,
        send_lease_until: lease,
      })),
    )
    .select('id, token_hash')
  const idByHash = new Map(((data ?? []) as Array<{ id: string; token_hash: string }>).map((row) => [row.token_hash, row.id]))
  if (error || rows.some(({ hash }) => !idByHash.has(hash))) {
    // The insert may have committed with its reply lost: retire whatever it wrote before anyone gives the claims back.
    const { error: retireError } = await service
      .from('supplier_invoice_attest_batches')
      .update({ consumed_at: new Date(now).toISOString(), send_lease_until: ATTEST_NOT_LEASED })
      .in('token_hash', rows.map(({ hash }) => hash))
      .is('mail_sent_at', null)
    throw new AttestBatchStoreError(!retireError, error ?? new Error('Attest batch not stored'))
  }
  return rows.map(({ intent, token, hash }) => {
    const batchId = idByHash.get(hash)!
    return { batch_id: batchId, attesterUserId: intent.attesterUserId, kind: intent.kind, invoiceIds: intent.invoiceIds, token, expires_at: expiresAt, lease_until: lease, attempt: 1 }
  })
}

/** A stored mail that has not gone out, as the retry reads it. */
export interface UnsentAttestBatch {
  id: string
  company_id: string
  attester_user_id: string
  kind: AttestBatchKind
  invoice_ids: string[]
  send_attempts: number
}

/**
 * The next try at an unsent mail, in ONE conditional update: a fresh token
 * (the old one stops working), a new expiry, the invoices still waiting and
 * a lease, only while the row is unsent, unretired, free (no run holds it,
 * or its lease lapsed) and still at the try this run read. Null when another run got
 * there first: two runs never try the same mail.
 */
export async function leaseAttestBatchRetry(
  service: SupabaseClient,
  row: UnsentAttestBatch,
  invoiceIds: readonly string[],
  options: { now?: number } = {},
): Promise<StoredAttestBatch | null> {
  const now = options.now ?? Date.now()
  const { token, hash } = generateInviteToken()
  const expiresAt = attestBatchExpiresAt(now)
  const lease = leaseUntil(now)
  const { data, error } = await service
    .from('supplier_invoice_attest_batches')
    .update({ token_hash: hash, expires_at: expiresAt, invoice_ids: [...invoiceIds], send_attempts: row.send_attempts + 1, send_lease_until: lease })
    .eq('id', row.id)
    .eq('send_attempts', row.send_attempts)
    .is('mail_sent_at', null)
    .is('consumed_at', null)
    .lt('send_lease_until', new Date(now).toISOString())
    .select('id')
  if (error) throw error
  if (((data ?? []) as unknown[]).length === 0) return null
  return {
    batch_id: row.id,
    attesterUserId: row.attester_user_id,
    kind: row.kind,
    invoiceIds: [...invoiceIds],
    token,
    expires_at: expiresAt,
    lease_until: lease,
    attempt: row.send_attempts + 1,
  }
}

/**
 * Retire an unsent mail nothing is left to send for (every invoice it listed
 * was answered or left attest), under the same conditions as a retry. True
 * when this call retired it.
 */
export async function retireUnsentAttestBatch(service: SupabaseClient, row: UnsentAttestBatch, options: { now?: number } = {}): Promise<boolean> {
  const now = options.now ?? Date.now()
  const { data, error } = await service
    .from('supplier_invoice_attest_batches')
    .update({ consumed_at: new Date(now).toISOString() })
    .eq('id', row.id)
    .eq('send_attempts', row.send_attempts)
    .is('mail_sent_at', null)
    .is('consumed_at', null)
    .lt('send_lease_until', new Date(now).toISOString())
    .select('id')
  if (error) throw error
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Take the send of a mail this run holds the lease on: mark it sent BEFORE
 * it is handed to the provider, so a run that dies mid-send never sends it
 * twice. The mark (the time written) when this call took it; null when the
 * lease lapsed and another run took the row.
 */
export async function takeAttestBatchSend(service: SupabaseClient, mail: StoredAttestBatch, options: { now?: number } = {}): Promise<string | null> {
  const mark = new Date(options.now ?? Date.now()).toISOString()
  const { data, error } = await service
    .from('supplier_invoice_attest_batches')
    .update({ mail_sent_at: mark, send_lease_until: ATTEST_NOT_LEASED })
    .eq('id', mail.batch_id)
    .eq('send_lease_until', mail.lease_until)
    .is('mail_sent_at', null)
    .is('consumed_at', null)
    .select('id')
  if (error) throw error
  return ((data ?? []) as unknown[]).length > 0 ? mark : null
}

/**
 * Give a mail back for a later try: one the provider certainly refused
 * (taken under `mark`: the mark is cleared and the row waits out a backoff
 * that grows with each try), or one this run did not get to (still leased:
 * the lease is given up and the next run may try it at once).
 */
export async function giveBackAttestBatch(
  service: SupabaseClient,
  mail: StoredAttestBatch,
  mark: string | null,
  options: { now?: number } = {},
): Promise<void> {
  const query = service.from('supplier_invoice_attest_batches')
  const notBefore = new Date((options.now ?? Date.now()) + attestRetryBackoffMs(mail.attempt)).toISOString()
  const { error } = mark
    ? await query.update({ mail_sent_at: null, send_lease_until: notBefore }).eq('id', mail.batch_id).eq('mail_sent_at', mark)
    : await query.update({ send_lease_until: ATTEST_NOT_LEASED }).eq('id', mail.batch_id).eq('send_lease_until', mail.lease_until).is('mail_sent_at', null)
  if (error) throw error
}

/** Retire a mail this run holds that can never go: no mail service, no address, nothing left to list. */
export async function retireHeldAttestBatch(service: SupabaseClient, mail: StoredAttestBatch, options: { now?: number } = {}): Promise<void> {
  const { error } = await service
    .from('supplier_invoice_attest_batches')
    .update({ consumed_at: new Date(options.now ?? Date.now()).toISOString(), send_lease_until: ATTEST_NOT_LEASED })
    .eq('id', mail.batch_id)
  if (error) throw error
}

export type ResolveAttestBatchResult =
  | { ok: true; batch: AttestBatchRow }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'expired' | 'consumed' }

/**
 * Resolve a clear token from the public surface (service-role client; the
 * token is the only guard: strict hash equality, then expiry and use). A
 * database without the table yet answers not_found. Never log the token.
 */
export async function resolveAttestBatch(
  service: SupabaseClient,
  token: string,
  options: { now?: number } = {},
): Promise<ResolveAttestBatchResult> {
  if (!isValidInviteTokenFormat(token)) return { ok: false, reason: 'invalid_format' }
  const { data, error } = await service
    .from('supplier_invoice_attest_batches')
    .select('id, company_id, attester_user_id, kind, invoice_ids, expires_at, mail_sent_at, consumed_at, created_at')
    .eq('token_hash', hashInviteToken(token))
    .maybeSingle()
  if (isMissingTableError(error)) return { ok: false, reason: 'not_found' }
  if (error) throw error
  const batch = (data as AttestBatchRow | null) ?? null
  if (!batch) return { ok: false, reason: 'not_found' }
  const now = options.now ?? Date.now()
  if (new Date(batch.expires_at).getTime() <= now) return { ok: false, reason: 'expired' }
  if (batch.consumed_at) return { ok: false, reason: 'consumed' }
  return { ok: true, batch: { ...batch, invoice_ids: batch.invoice_ids ?? [] } }
}

/** Every listed invoice is answered (or left attest): the link has done its work. */
export async function consumeAttestBatch(service: SupabaseClient, batchId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service
    .from('supplier_invoice_attest_batches')
    .update({ consumed_at: new Date(now).toISOString() })
    .eq('id', batchId)
    .is('consumed_at', null)
  if (error) throw error
}

export type QueueAttestRequestResult = 'queued' | 'unavailable'

/**
 * Put a registered invoice in the queue the request job reads. 'unavailable'
 * while the migration has not reached this database: the caller then mails
 * the attesters the old way, one invoice at a time. Queuing the same
 * invoice twice keeps the first row.
 */
export async function queueAttestRequest(service: SupabaseClient, companyId: string, invoiceId: string): Promise<QueueAttestRequestResult> {
  const { error } = await service
    .from('supplier_invoice_attest_mail_state')
    .upsert({ supplier_invoice_id: invoiceId, company_id: companyId }, { onConflict: 'supplier_invoice_id', ignoreDuplicates: true })
  if (isMissingTableError(error)) return 'unavailable'
  if (error) throw error
  return 'queued'
}
