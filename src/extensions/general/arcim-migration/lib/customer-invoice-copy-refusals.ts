/**
 * Customer invoice copies Fortnox will not hand out.
 *
 * The underlag import asks Fortnox for each migrated customer invoice as PDF
 * (the preview action, import-documents.ts). For some invoices Fortnox answers
 * with a client error on that one invoice (400 Bad Request, 297 times in two
 * days for four companies in the production logs of 2026-11-12), and asking
 * again gives the same answer. Each run used to ask every such invoice again
 * and log an error for each.
 *
 * An answer like that is now kept per invoice, with Fortnox's own code and
 * sentence as the reason, in extension_data under the company. A later run
 * counts the invoice as not fetched without a call, until the answer is
 * COPY_REFUSAL_RETRY_AFTER_MS old: then it is asked once more, so a cause
 * that was cured in Fortnox (or in our request) is picked up without anybody
 * clearing anything.
 *
 * Only answers that are about the one invoice are kept. A dead token (401), a
 * refused scope or licence (fortnoxRefusal), a rate limit (429) and anything
 * a retry may cure (408, 425, 5xx, a timeout) are handled by their own paths.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { FortnoxApiError, fortnoxApiErrorCode, fortnoxErrorMessage } from '@/lib/providers/fortnox/client'

const EXTENSION_ID = 'arcim-migration'

/** extension_data key, per company: `{ [accountKey]: { [documentNumber]: CopyRefusal } }`. */
export const CUSTOMER_INVOICE_COPY_REFUSALS_KEY = 'customer_invoice_copy_refusals'

/** A kept refusal stops the calls for this long, then the invoice is asked once more. */
export const COPY_REFUSAL_RETRY_AFTER_MS = 7 * 24 * 60 * 60_000

/** Refusals kept per Fortnox account; past it the newest are not kept (and so asked again). */
export const MAX_KEPT_COPY_REFUSALS = 5000

/** Client errors a later call may cure: never kept. */
const RETRYABLE_CLIENT_STATUSES = new Set([401, 408, 425, 429])

export interface CopyRefusal {
  /** The HTTP status Fortnox answered with. */
  status: number
  /** Fortnox's numeric error code (ErrorInformation.code), when the body names one. */
  code: string | null
  /** Fortnox's own sentence, when the body carries one. */
  message: string | null
  /** When Fortnox answered (ISO). */
  at: string
}

type RefusalsByAccount = Record<string, Record<string, CopyRefusal>>

/**
 * What Fortnox answered when the answer is about this one invoice and will
 * not change by asking again; null for everything else.
 */
export function permanentCopyRefusal(error: unknown, nowMs: number): CopyRefusal | null {
  if (!(error instanceof FortnoxApiError)) return null
  const status = error.statusCode
  if (status < 400 || status >= 500 || RETRYABLE_CLIENT_STATUSES.has(status)) return null
  return {
    status,
    code: fortnoxApiErrorCode(error) ?? null,
    message: fortnoxErrorMessage(error),
    at: new Date(nowMs).toISOString(),
  }
}

function isCopyRefusal(value: unknown): value is CopyRefusal {
  if (!value || typeof value !== 'object') return false
  const refusal = value as Partial<CopyRefusal>
  return typeof refusal.status === 'number' && typeof refusal.at === 'string' && Number.isFinite(Date.parse(refusal.at))
}

/** The account's kept refusals that still hold at `nowMs`, by Fortnox document number. */
export function currentCopyRefusals(value: unknown, accountKey: string, nowMs: number): Map<string, CopyRefusal> {
  const current = new Map<string, CopyRefusal>()
  const account = value && typeof value === 'object' ? (value as RefusalsByAccount)[accountKey] : undefined
  if (!account || typeof account !== 'object') return current
  for (const [documentNumber, refusal] of Object.entries(account)) {
    if (isCopyRefusal(refusal) && nowMs - Date.parse(refusal.at) < COPY_REFUSAL_RETRY_AFTER_MS) {
      current.set(documentNumber, refusal)
    }
  }
  return current
}

async function readStored(supabase: SupabaseClient, companyId: string): Promise<unknown> {
  const { data, error } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', EXTENSION_ID)
    .eq('key', CUSTOMER_INVOICE_COPY_REFUSALS_KEY)
    .maybeSingle()
  if (error) throw new Error(`customer invoice copy refusals not read: ${error.message}`)
  return (data as { value?: unknown } | null)?.value ?? null
}

export async function readCopyRefusals(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  nowMs: number,
): Promise<Map<string, CopyRefusal>> {
  return currentCopyRefusals(await readStored(supabase, companyId), accountKey, nowMs)
}

/**
 * Keep `added` for the account. Read again first, so another slice's
 * refusals stay; what has expired, and what `settled` names (invoices that
 * hold their copy by now), is dropped.
 */
export async function keepCopyRefusals(
  supabase: SupabaseClient,
  scope: { companyId: string; userId: string; accountKey: string },
  added: ReadonlyMap<string, CopyRefusal>,
  settled: ReadonlySet<string>,
  nowMs: number,
): Promise<void> {
  const stored = await readStored(supabase, scope.companyId)
  const kept = currentCopyRefusals(stored, scope.accountKey, nowMs)
  for (const documentNumber of settled) kept.delete(documentNumber)
  for (const [documentNumber, refusal] of added) {
    if (kept.size >= MAX_KEPT_COPY_REFUSALS && !kept.has(documentNumber)) break
    kept.set(documentNumber, refusal)
  }
  const value: RefusalsByAccount = {
    ...(stored && typeof stored === 'object' ? (stored as RefusalsByAccount) : {}),
    [scope.accountKey]: Object.fromEntries(kept),
  }
  const { error } = await supabase.from('extension_data').upsert(
    {
      user_id: scope.userId,
      company_id: scope.companyId,
      extension_id: EXTENSION_ID,
      key: CUSTOMER_INVOICE_COPY_REFUSALS_KEY,
      value,
    },
    { onConflict: 'company_id,extension_id,key' },
  )
  if (error) throw new Error(`customer invoice copy refusals not kept: ${error.message}`)
}

/** The distinct answers among the refusals, most common first: what one log line per run names. */
export function copyRefusalCauses(
  refusals: Iterable<CopyRefusal>,
  limit = 5,
): { status: number; code: string | null; message: string | null; count: number }[] {
  const causes = new Map<string, { status: number; code: string | null; message: string | null; count: number }>()
  for (const { status, code, message } of refusals) {
    const key = `${status}|${code ?? ''}|${message ?? ''}`
    const cause = causes.get(key)
    if (cause) cause.count++
    else causes.set(key, { status, code, message, count: 1 })
  }
  return [...causes.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}
