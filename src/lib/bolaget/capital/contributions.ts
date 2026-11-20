/**
 * Aktieägartillskott (K2 15.5-15.6, BFNAR 2016:10 as amended by 2025:2).
 *
 * A tillskott, villkorat or ovillkorat, is booked to balanserat resultat
 * when the utfästelse is received (K2 15.5): here on 2093 Erhållna
 * aktieägartillskott, the BAS account in that group (the booking template
 * shareholder_contribution, D 1930 / K 2093, holds for both kinds). Paid at
 * once, the debit is the bank account; promised and not yet paid, it is
 * 1685 Kortfristiga fordringar hos delägare.
 *
 * A villkorat tillskott may be repaid out of distributable equity when the
 * stämma decides it (K2 15.6). The repayment (D 2093 / K bank) is booked
 * with a warning when no stämma decision is referenced, and is checked
 * against fritt eget kapital as a warning: the rule is the company's to
 * apply, the register only says what it sees.
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre, sumOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { checkPartyRef, ensureRegisterParty, loadRegisterParties, type PartyRef } from '../people'
import { checkFreeEquity } from './free-equity'
import { contributionLines, contributionRepaymentLines, postCapitalEntry } from './postings'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import type { CapitalDecidedBy, ContributionKind } from './types'

export interface ContributionRow {
  id: string
  party_id: string
  kind: ContributionKind
  repays_contribution_id: string | null
  promised_on: string
  amount: number
  conditional: boolean
  decided_on: string | null
  decided_by: CapitalDecidedBy | null
  decision_id: string | null
  document_id: string | null
  counter_account: string
  journal_entry_id: string | null
  status: 'registered' | 'booked' | 'cancelled'
  note: string | null
  created_at: string
}


export async function loadContributions(ctx: OperationContext): Promise<ContributionRow[]> {
  const { data, error } = await ctx.supabase
    .from('shareholder_contributions')
    .select('id, party_id, kind, repays_contribution_id, promised_on, amount, conditional, decided_on, decided_by, decision_id, document_id, counter_account, journal_entry_id, status, note, created_at')
    .eq('company_id', ctx.companyId)
    .order('promised_on', { ascending: false })
  if (error) throw new Error(`shareholder_contributions read failed: ${error.message}`)
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ ...(r as unknown as ContributionRow), amount: Number(r.amount) }))
}

export interface ContributionInput {
  /** The shareholder: an existing party, or a new one by name. Ignored for a repayment (the tillskott's holder). */
  holder?: PartyRef | null
  kind?: ContributionKind | null
  /** The utfästelse (contribution) or the payment day (repayment). */
  promised_on: string
  amount: number
  /** Villkorat (may be repaid) or ovillkorat. A repayment inherits it from the tillskott. */
  conditional?: boolean | null
  /** Repayment: the villkorat tillskott repaid. */
  repays_contribution_id?: string | null
  decided_on?: string | null
  decided_by?: CapitalDecidedBy | null
  decision_id?: string | null
  document_id?: string | null
  /** The bank account (19xx), or 1685 for a tillskott promised and not yet paid. */
  counter_account?: string | null
  note?: string | null
}

export interface ContributionCreated {
  shareholder_contribution_id: string
  kind: ContributionKind
  party_id: string
  amount: number
  journal_entry_id: string
}

function warning(code: string, sv: string, en: string): OperationWarning {
  return { code, message_sv: sv, message_en: en }
}

export async function createShareholderContribution(
  ctx: OperationContext,
  input: ContributionInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<ContributionCreated>> {
  const kind: ContributionKind = input.kind ?? 'contribution'
  if (input.promised_on > todayIsoStockholm()) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Datumet kan inte ligga i framtiden.' }
  const amount = roundOre(input.amount)
  if (!(amount > 0)) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange ett belopp över noll.' }
  const counter = input.counter_account ?? (await resolvePrimaryBankAccount(ctx.supabase, ctx.companyId, ctx.log))
  if (!/^(19\d\d|1685)$/.test(counter) || (kind === 'repayment' && counter === '1685')) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange ett bankkonto (19xx), eller 1685 för ett tillskott som utlovats men inte betalats.' }
  }
  const warnings: OperationWarning[] = []
  let partyRef: PartyRef = input.holder ?? {}
  let conditional = input.conditional === true

  if (kind === 'repayment') {
    if (!input.repays_contribution_id) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange vilket villkorat tillskott som återbetalas.' }
    const all = await loadContributions(ctx)
    const original = all.find((c) => c.id === input.repays_contribution_id)
    if (!original || original.kind !== 'contribution' || original.status !== 'booked') return { ok: false, code: 'CONTRIBUTION_NOT_FOUND' }
    if (!original.conditional) return { ok: false, code: 'CONTRIBUTION_NOT_CONDITIONAL' }
    const repaid = sumOre(all.filter((c) => c.kind === 'repayment' && c.repays_contribution_id === original.id && c.status === 'booked').map((c) => c.amount))
    const left = roundOre(original.amount - repaid)
    if (amount > left) return { ok: false, code: 'CONTRIBUTION_REPAYMENT_EXCEEDS', details: { left }, messageSv: `Det återstår ${left} kr av tillskottet att återbetala.` }
    partyRef = { party_id: original.party_id }
    conditional = true
    const stamma = input.decided_by === 'arsstamma' || input.decided_by === 'extra_stamma'
    if (!stamma || (!input.decided_on && !input.decision_id)) {
      warnings.push(warning(
        'CONTRIBUTION_REPAYMENT_DECISION_MISSING',
        'Återbetalning av ett villkorat aktieägartillskott ska beslutas av bolagsstämman. Ange stämmans beslut.',
        'Repaying a conditional shareholder contribution needs a decision of the general meeting. Reference the decision.',
      ))
    }
    const check = await checkFreeEquity(ctx.supabase, ctx.companyId, input.promised_on, amount)
    if (check.exceeds) {
      warnings.push(warning(
        'CONTRIBUTION_REPAYMENT_EXCEEDS_FREE_EQUITY',
        `Återbetalningen (${amount} kr) överstiger det fria egna kapitalet som finns kvar (${check.available} kr). En återbetalning får bara ske ur fritt eget kapital.`,
        `The repayment (${amount} kr) exceeds the free equity left (${check.available} kr). It may only be made out of free equity.`,
      ))
    }
  } else {
    checkPartyRef(partyRef, 'aktieägaren')
    if (counter === '1685') {
      warnings.push(warning(
        'CONTRIBUTION_PROMISED',
        'Tillskottet bokförs som en fordran på aktieägaren (1685) tills det betalas.',
        'The contribution is booked as a receivable from the shareholder (1685) until paid.',
      ))
    }
  }

  const lines = kind === 'repayment' ? contributionRepaymentLines(counter, amount) : contributionLines(counter, amount, conditional)
  if (dryRun) {
    const name = partyRef.party_id ? (await loadRegisterParties(ctx.companyId, [partyRef.party_id])).get(partyRef.party_id)?.name ?? null : partyRef.name ?? null
    return {
      ok: true,
      dryRun: true,
      preview: {
        kind,
        holder: { party_id: partyRef.party_id ?? null, name },
        entry_date: input.promised_on,
        amount,
        conditional,
        lines: lines.map((l) => ({ account_number: l.account_number, debit: l.debit_amount, credit: l.credit_amount })),
        warnings: warnings.map((w) => w.message_sv),
      },
    }
  }

  const partyId = await ensureRegisterParty(ctx, partyRef)
  const entry = await postCapitalEntry({
    supabase: ctx.supabase,
    companyId: ctx.companyId,
    userId: ctx.userId,
    entryDate: input.promised_on,
    description: kind === 'repayment' ? 'Återbetalning av villkorat aktieägartillskott' : conditional ? 'Villkorat aktieägartillskott' : 'Ovillkorat aktieägartillskott',
    lines,
    category: 'owner.transfer',
    pendingOperationId: ctx.pendingOperationId ?? null,
  })
  const { data, error } = await ctx.supabase
    .from('shareholder_contributions')
    .insert({
      company_id: ctx.companyId,
      party_id: partyId,
      kind,
      repays_contribution_id: kind === 'repayment' ? input.repays_contribution_id : null,
      promised_on: input.promised_on,
      amount,
      conditional,
      decided_on: input.decided_on ?? null,
      decided_by: input.decided_by ?? null,
      decision_id: input.decision_id ?? null,
      document_id: input.document_id ?? null,
      counter_account: counter,
      journal_entry_id: entry.id,
      status: 'booked',
      note: input.note?.trim() || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single()
  if (error) {
    ctx.log.error('[bolaget] contribution booked but not recorded', new Error(error.message), { companyId: ctx.companyId, entryId: entry.id })
    return { ok: false, code: 'CONTRIBUTION_RECORD_FAILED', partialPostedIds: { journal_entry_id: entry.id } }
  }
  return {
    ok: true,
    data: { shareholder_contribution_id: (data as { id: string }).id, kind, party_id: partyId, amount, journal_entry_id: entry.id },
    created: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
