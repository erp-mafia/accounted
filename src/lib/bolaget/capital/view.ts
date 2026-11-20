/**
 * The capital events as every door answers them: names and masked
 * identities only (never a personnummer), qualified ids, numbers as numbers.
 * The dashboard page, the v1 read and the MCP read share it.
 */
import type { OperationContext } from '@/lib/operations/types'
import { loadRegisterParties } from '../people'
import type { RegisterParty } from '../types'
import { loadCapitalChanges } from './capital-changes'
import { loadContributions } from './contributions'
import { loadDistributions, loadDividends } from './dividends'
import { CAPITAL_CHANGE_LABELS_SV } from './types'

function identity(p: RegisterParty | undefined): string | null {
  if (!p) return null
  return p.kind === 'company' ? p.org_number : p.personnummer_masked
}

export async function loadCapitalView(ctx: OperationContext) {
  const [dividends, contributions, changes] = await Promise.all([loadDividends(ctx.supabase, ctx.companyId), loadContributions(ctx), loadCapitalChanges(ctx)])
  const distributions = await loadDistributions(ctx.supabase, ctx.companyId, dividends.map((d) => d.id))
  const partyIds = [
    ...[...distributions.values()].flat().map((r) => r.party_id),
    ...contributions.map((c) => c.party_id),
    ...changes.flatMap((c) => c.allotments.map((a) => a.party_id)).filter((id): id is string => Boolean(id)),
  ]
  const parties = await loadRegisterParties(ctx.companyId, partyIds)
  const holder = (partyId: string) => {
    const p = parties.get(partyId)
    return { party_id: partyId, name: p?.name ?? '', kind: p?.kind ?? 'person', identity: identity(p), has_personnummer: p?.kind === 'person' ? Boolean(p.personnummer_masked) : null }
  }
  return {
    dividends: dividends.map((d) => ({
      dividend_id: d.id,
      decided_on: d.decided_on,
      decided_by: d.decided_by,
      origin: d.origin,
      status: d.status,
      amount_per_share: d.amount_per_share,
      total_amount: d.total_amount,
      record_date: d.record_date,
      record_date_basis: d.record_date_basis,
      payment_date: d.payment_date,
      paid_on: d.paid_on,
      source_account: d.source_account,
      prudence_confirmed: d.prudence_confirmed,
      decision_id: d.decision_id,
      decision_entry_id: d.decision_entry_id,
      payout_entry_id: d.payout_entry_id,
      note: d.note,
      holders: (distributions.get(d.id) ?? []).map((r) => ({ ...holder(r.party_id), share_count: r.share_count, amount: r.amount })),
    })),
    contributions: contributions.map((c) => {
      const h = holder(c.party_id)
      return {
        shareholder_contribution_id: c.id,
        kind: c.kind,
        party_id: h.party_id,
        name: h.name,
        holder_kind: h.kind,
        identity: h.identity,
        has_personnummer: h.has_personnummer,
        promised_on: c.promised_on,
        amount: c.amount,
        conditional: c.conditional,
        repays_contribution_id: c.repays_contribution_id,
        decided_on: c.decided_on,
        decided_by: c.decided_by,
        decision_id: c.decision_id,
        counter_account: c.counter_account,
        journal_entry_id: c.journal_entry_id,
        status: c.status,
        note: c.note,
      }
    }),
    capital_changes: changes.map((c) => ({
      capital_change_id: c.id,
      kind: c.kind,
      kind_label: CAPITAL_CHANGE_LABELS_SV[c.kind],
      decided_on: c.decided_on,
      decided_by: c.decided_by,
      decision_id: c.decision_id,
      share_count: c.share_count,
      share_capital_amount: c.share_capital_amount,
      price_per_share: c.price_per_share,
      premium_amount: c.premium_amount,
      source_account: c.source_account,
      purpose: c.purpose,
      target_account: c.target_account,
      registered_on: c.registered_on,
      payment_entry_id: c.payment_entry_id,
      registration_entry_id: c.registration_entry_id,
      status: c.status,
      allotments: c.allotments.map((a) => ({
        party_id: a.party_id,
        name: a.party_id ? parties.get(a.party_id)?.name ?? '' : a.name ?? '',
        share_count: a.share_count,
        amount: a.amount,
        share_register_event_id: a.share_register_event_id,
      })),
      note: c.note,
    })),
  }
}

export type CapitalView = Awaited<ReturnType<typeof loadCapitalView>>
