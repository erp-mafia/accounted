import type { SupabaseClient } from '@supabase/supabase-js'
import { nextStepKind, type NextStepKind } from '@/lib/receipt-hunt/agent-worklist'
import { createLogger } from '@/lib/logger'

const log = createLogger('worklist/missing-underlag')

/**
 * What the "Verifikat utan underlag" row can say about the work behind it.
 *
 * The errand is derived, never stored: which of a handful of places a receipt
 * has to be fetched from follows from the purchase descriptor, so Accounted
 * can say it without an agent having run and without a note written back from
 * a chat the user has already closed. The agent's per-item sentence and this
 * summary come out of the same classifier (lib/receipt-hunt/agent-worklist),
 * so they cannot drift apart.
 */
export interface MissingUnderlagSample {
  /** Total missing underlag, counted over the full set inside the RPC. */
  total: number
  /** How many rows were actually classified: total, capped at the page size. */
  sampled: number
  /** The most common errand among the sampled rows, largest amounts first. */
  top: { kind: NextStepKind; count: number } | null
}

/**
 * One page is enough: the rows come back largest-amount first, and the line
 * this feeds says what the biggest ones need, not what every last row needs.
 */
export const MISSING_UNDERLAG_SAMPLE = 25

const EMPTY: MissingUnderlagSample = { total: 0, sampled: 0, top: null }

/**
 * The same `verifikat_without_documents` RPC the count uses, asked for a real
 * page instead of `p_limit: 1`. `total_count` is computed over the full
 * filtered set inside the RPC either way, so this replaces the count call
 * rather than adding a query: pass the result to getWorklistCounts as
 * `missingUnderlag` and Hem still makes exactly one call.
 */
export async function listMissingUnderlagSample(
  supabase: SupabaseClient,
  companyId: string,
): Promise<MissingUnderlagSample> {
  try {
    const { data, error } = await supabase.rpc('verifikat_without_documents', {
      p_company_id: companyId,
      p_limit: MISSING_UNDERLAG_SAMPLE,
      p_offset: 0,
    })
    if (error) {
      log.error('missing underlag sample failed', { companyId, reason: error.message })
      return EMPTY
    }
    const result = data as {
      ok?: boolean
      code?: string
      total_count?: number
      verifikat?: { description: string | null }[]
    } | null
    if (!result?.ok) {
      log.error('missing underlag sample failed', {
        companyId,
        reason: result?.code ?? 'rpc returned not-ok',
      })
      return EMPTY
    }
    return summariseMissingUnderlag(result.total_count ?? 0, result.verifikat ?? [])
  } catch (err) {
    log.error('missing underlag sample failed', {
      companyId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return EMPTY
  }
}

/**
 * Pure half, so the grouping is testable without a database.
 *
 * The RPC gives the entry description; the agent worklist classifies on the
 * counterparty when it has resolved one, and falls back to the same
 * description. A summary line is therefore never more specific than the
 * per-item sentence, which is the right direction to be wrong in.
 */
export function summariseMissingUnderlag(
  total: number,
  rows: { description: string | null }[],
): MissingUnderlagSample {
  if (total === 0 || rows.length === 0) return { total, sampled: 0, top: null }

  const tally = new Map<NextStepKind, number>()
  for (const row of rows) {
    const kind = nextStepKind(row.description)
    tally.set(kind, (tally.get(kind) ?? 0) + 1)
  }

  let top: { kind: NextStepKind; count: number } | null = null
  for (const [kind, count] of tally) {
    if (!top || count > top.count) top = { kind, count }
  }
  return { total, sampled: rows.length, top }
}
