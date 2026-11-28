import type { SupabaseClient } from '@supabase/supabase-js'
import { proposeForTransactions } from '@/lib/transactions/propose'
import { slateAccount, type BookingProposal } from '@/lib/bookkeeping/proposal'
import type { Transaction, VatTreatment } from '@/types'
import type { AccountCandidate } from './select-account'

/**
 * Tier 1 of the auto-booking cascade: the deterministic candidate slate.
 *
 * The same proposals the transactions page and the MCP suggestion tool
 * show (lib/transactions/propose.ts), reduced to the accounts the Tier-2
 * selector reasons over: a learned counterpart, a rule that matched, the
 * company's own earlier booking of the counterparty, the catalog's patterns. The assistant's own earlier read is left out, so the
 * model never argues from itself. No model call here.
 *
 * Company-scoped throughout. Returns at most `limit` candidates, de-duplicated
 * by account (highest confidence wins), highest confidence first.
 */
export async function gatherCandidates(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
  limit = 8,
): Promise<AccountCandidate[]> {
  const { proposals } = await proposeForTransactions(supabase, companyId, [transaction], { withReads: false })
  const raw = (proposals[transaction.id] ?? [])
    .filter((p) => p.source !== 'assistant' && p.source !== 'recent')
    .map(candidateFromProposal)
  return dedupeByAccount(raw).slice(0, limit)
}

export function candidateFromProposal(p: BookingProposal): AccountCandidate {
  return {
    account: slateAccount(p),
    label: p.name_sv,
    // Unknown moms has no treatment: the review rate it opens with
    // (withUnknownVat) is not one.
    vatTreatment: p.vat_unknown
      ? null
      : ((p.booking.kind === 'account' ? p.booking.vat_treatment : p.vat_treatment) as VatTreatment | null),
    ...(p.vat_unknown ? { vatUnknown: true } : {}),
    source:
      p.source === 'counterparty'
        ? 'counterparty_template'
        : p.source === 'rule'
          ? 'mapping_rule'
          : p.source === 'precedent'
            ? 'history'
            : 'pattern',
    confidence: p.confidence,
    matchReason: p.description_sv || undefined,
  }
}

/** Keep one candidate per account (the highest-confidence one), highest confidence first. */
function dedupeByAccount(candidates: AccountCandidate[]): AccountCandidate[] {
  const best = new Map<string, AccountCandidate>()
  for (const c of candidates) {
    const existing = best.get(c.account)
    if (!existing || c.confidence > existing.confidence) best.set(c.account, c)
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence)
}
