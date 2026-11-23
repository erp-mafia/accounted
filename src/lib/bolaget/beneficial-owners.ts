/**
 * Verkliga huvudmän (LRVH 2017:631), derived from the aktiebok.
 *
 * The proposal: every natural person holding MORE than 25 % of the votes
 * (LRVH 1:3); a company holding more than 25 % is listed for the person to
 * investigate who controls it (indirect ownership), never turned into a
 * person by us. Close family holdings counted together (1:5) and control by
 * agreement (1:3-4) are questions only the company can answer: the person
 * confirms them, and the confirmation is the LRVH 2:1 record (date, basis,
 * conclusion, who), kept append-only. A confirmed set that differs from the
 * one before raises a deadline to file the change with Bolagsverket "utan
 * dröjsmål" (2:3) through its e-service (there is no API).
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createServiceClient } from '@/lib/supabase/server'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { bolagetFailure } from './errors'
import { activeOn, dayBefore } from './roles'
import { loadShareRegisterData } from './share-register'
import { loadRegisterParties } from './people'
import type { HoldingsSummary } from './register-state'
import type { CompanyRole, RegisterParty } from './types'

/** Bolagsverket's e-service for verkliga huvudmän (not on verksamt.se). */
export const BENEFICIAL_OWNER_FILING_URL = 'https://bolagsverket.se/sjalvservice/etjanster/verklighuvudman/anmalverklighuvudman.3083.html'

export const BO_CONTROL_KINDS = ['votes', 'indirect', 'agreement', 'board_appointment', 'other'] as const
export type BoControlKind = (typeof BO_CONTROL_KINDS)[number]

export interface BoCandidate {
  party_id: string
  name: string
  kind: 'person' | 'company'
  votes_pct: number
  capital_pct: number
  /** A sentence for the record: "60 % av rösterna och 60 % av kapitalet genom eget ägande." */
  extent: string
}

export interface BoProposal {
  as_of: string
  /** Natural persons with more than 25 % of the votes. */
  owners: BoCandidate[]
  /** Companies with more than 25 % of the votes: who controls them must be found out. */
  indirect: BoCandidate[]
  conclusion: 'owners_identified' | 'no_beneficial_owner'
}

function pctText(n: number): string {
  return String(n).replace('.', ',')
}

/** The proposal from the holdings on a date. Pure. */
export function proposeBeneficialOwners(summary: HoldingsSummary, parties: ReadonlyMap<string, RegisterParty>, asOf: string): BoProposal {
  const owners: BoCandidate[] = []
  const indirect: BoCandidate[] = []
  for (const h of summary.holders) {
    // More than a quarter, compared exactly: 25,00 % is not enough.
    if (!(summary.total_votes > 0 && h.votes * 4 > summary.total_votes)) continue
    const party = parties.get(h.party_id)
    const candidate: BoCandidate = {
      party_id: h.party_id,
      name: party?.name ?? 'Okänd',
      kind: party?.kind ?? 'person',
      votes_pct: h.votes_pct,
      capital_pct: h.capital_pct,
      extent: `${pctText(h.votes_pct)} % av rösterna och ${pctText(h.capital_pct)} % av kapitalet genom eget ägande.`,
    }
    if (candidate.kind === 'company') indirect.push(candidate)
    else owners.push(candidate)
  }
  return { as_of: asOf, owners, indirect, conclusion: owners.length > 0 ? 'owners_identified' : 'no_beneficial_owner' }
}

export interface BoAssessment {
  beneficial_owner_assessment_id: string
  assessed_on: string
  basis: string
  conclusion: 'owners_identified' | 'no_beneficial_owner'
  owners: Array<{ party_id: string; name: string; extent: string | null; control: string | null; votes_pct: number | null; capital_pct: number | null }>
  family_aggregation_checked: boolean
  family_note: string | null
  control_agreements: boolean
  control_note: string | null
  changed: boolean
  /** A change that was filed: its "Anmäl verklig huvudman" reminder is marked done. */
  filed?: boolean
  created_at: string
}

export interface BoView {
  proposal: BoProposal
  /** The verkliga huvudmän confirmed and in force on as_of. */
  confirmed: Array<{ company_role_id: string; party_id: string; name: string; extent: string | null; valid_from: string | null }>
  assessments: BoAssessment[]
  /** The proposal names other persons than the confirmed set: a new assessment is due. */
  differs: boolean
  filing_url: string
}

async function loadBoRoles(ctx: OperationContext): Promise<CompanyRole[]> {
  const { data, error } = await ctx.supabase
    .from('company_roles')
    .select('id, party_id, role, valid_from, valid_to, source, decision_id, registered_at, details, created_at')
    .eq('company_id', ctx.companyId)
    .eq('role', 'verklig_huvudman')
  if (error) throw new Error(`company_roles read failed: ${error.message}`)
  return (data ?? []) as CompanyRole[]
}

export async function loadBoAssessments(ctx: OperationContext, limit = 20): Promise<BoAssessment[]> {
  const { data, error } = await ctx.supabase
    .from('beneficial_owner_assessments')
    .select('id, assessed_on, basis, conclusion, owners, family_aggregation_checked, family_note, control_agreements, control_note, changed, created_at')
    .eq('company_id', ctx.companyId)
    .order('assessed_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`beneficial_owner_assessments read failed: ${error.message}`)
  return ((data ?? []) as Array<Omit<BoAssessment, 'beneficial_owner_assessment_id'> & { id: string }>).map(({ id, ...rest }) => ({
    beneficial_owner_assessment_id: id,
    ...rest,
  }))
}

/** The reminder a changed assessment files (confirmBeneficialOwners) carries this key. */
export function beneficialOwnerReminderKey(assessmentId: string): string {
  return `bolaget:verklig-huvudman:${assessmentId}`
}

/**
 * Mark the changed assessments whose reminder is done: the person filed the
 * change with Bolagsverket and said so on the deadline (or, for a company
 * set up from a formation, it was filed with the registration).
 */
export async function withFiled(ctx: OperationContext, assessments: BoAssessment[]): Promise<BoAssessment[]> {
  const keys = assessments.filter((a) => a.changed).map((a) => beneficialOwnerReminderKey(a.beneficial_owner_assessment_id))
  if (keys.length === 0) return assessments
  const { data, error } = await ctx.supabase
    .from('deadlines')
    .select('source_key')
    .eq('company_id', ctx.companyId)
    .in('source_key', keys)
    .eq('is_completed', true)
  if (error) throw new Error(`deadlines read failed: ${error.message}`)
  const done = new Set(((data ?? []) as Array<{ source_key: string }>).map((d) => d.source_key))
  return assessments.map((a) => (a.changed ? { ...a, filed: done.has(beneficialOwnerReminderKey(a.beneficial_owner_assessment_id)) } : a))
}

/** The proposal, the confirmed set and the record of earlier assessments. */
export async function loadBeneficialOwnerView(ctx: OperationContext, asOf: string | null = null): Promise<BoView> {
  const register = await loadShareRegisterData(ctx, asOf)
  const proposal = proposeBeneficialOwners(register.summary, register.parties, register.as_of)
  const [roles, assessments] = await Promise.all([loadBoRoles(ctx), loadBoAssessments(ctx)])
  const active = roles.filter((r) => activeOn(r, register.as_of))
  const names = await loadRegisterParties(ctx.companyId, active.map((r) => r.party_id))
  const confirmed = active.map((r) => ({
    company_role_id: r.id,
    party_id: r.party_id,
    name: names.get(r.party_id)?.name ?? 'Okänd',
    extent: typeof r.details?.extent === 'string' ? (r.details.extent as string) : null,
    valid_from: r.valid_from,
  }))
  const proposed = new Set(proposal.owners.map((o) => o.party_id))
  const current = new Set(confirmed.map((c) => c.party_id))
  const differs = proposed.size !== current.size || [...proposed].some((id) => !current.has(id)) || (assessments.length === 0 && register.summary.total_shares > 0)
  return { proposal, confirmed, assessments: await withFiled(ctx, assessments), differs, filing_url: BENEFICIAL_OWNER_FILING_URL }
}

export interface ConfirmBoInput {
  assessed_on: string
  conclusion: 'owners_identified' | 'no_beneficial_owner'
  owners: Array<{ party_id: string; extent?: string | null; control?: BoControlKind | null }>
  basis?: string | null
  family_aggregation_checked: boolean
  family_note?: string | null
  control_agreements: boolean
  control_note?: string | null
}

export interface ConfirmBoResult {
  beneficial_owner_assessment_id: string
  changed: boolean
  ended_role_ids: string[]
  added_role_ids: string[]
  deadline_source_key: string | null
  filing_url: string
}

/**
 * Record an assessment (dry-runnable): the LRVH 2:1 record, the
 * verklig_huvudman roles brought in line with it, and, when the set
 * changed, a deadline to file the change with Bolagsverket.
 */
export async function confirmBeneficialOwners(
  ctx: OperationContext,
  input: ConfirmBoInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<ConfirmBoResult>> {
  try {
    const today = todayIsoStockholm()
    if (input.assessed_on > today) return { ok: false, code: 'BOLAGET_DATES_INVALID' }
    const ownerIds = [...new Set(input.owners.map((o) => o.party_id))]
    if (input.conclusion === 'owners_identified' && ownerIds.length === 0) return { ok: false, code: 'BENEFICIAL_OWNER_INVALID' }
    if (input.conclusion === 'no_beneficial_owner' && ownerIds.length > 0) return { ok: false, code: 'BENEFICIAL_OWNER_INVALID' }

    const register = await loadShareRegisterData(ctx, input.assessed_on)
    const parties = await loadRegisterParties(ctx.companyId, ownerIds)
    for (const id of ownerIds) {
      const p = parties.get(id)
      if (!p) return { ok: false, code: 'BOLAGET_PARTY_NOT_FOUND' }
      // A verklig huvudman is always a natural person (LRVH 1:2).
      if (p.kind !== 'person') return { ok: false, code: 'BENEFICIAL_OWNER_INVALID', messageSv: `${p.name} är ett företag. En verklig huvudman är alltid en fysisk person.` }
    }
    const holderById = new Map(register.summary.holders.map((h) => [h.party_id, h]))
    const proposal = proposeBeneficialOwners(register.summary, register.parties, register.as_of)
    const extentDefault = new Map(proposal.owners.map((o) => [o.party_id, o.extent]))
    const owners = input.owners.map((o) => {
      const h = holderById.get(o.party_id)
      return {
        party_id: o.party_id,
        name: parties.get(o.party_id)!.name,
        extent: o.extent?.trim() || extentDefault.get(o.party_id) || null,
        control: o.control ?? (h ? 'votes' : 'other'),
        votes_pct: h?.votes_pct ?? null,
        capital_pct: h?.capital_pct ?? null,
      }
    })

    const roles = await loadBoRoles(ctx)
    const activeRoles = roles.filter((r) => r.valid_to === null)
    const before = new Set(activeRoles.map((r) => r.party_id))
    const after = new Set(ownerIds)
    const changed = before.size !== after.size || [...after].some((id) => !before.has(id))
    const toEnd = activeRoles.filter((r) => !after.has(r.party_id))
    const toAdd = ownerIds.filter((id) => !before.has(id))
    const basis = input.basis?.trim() || `Aktieboken per ${input.assessed_on}`

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          assessed_on: input.assessed_on,
          conclusion: input.conclusion,
          basis,
          owners: owners.map((o) => ({ party_id: o.party_id, name: o.name, extent: o.extent })),
          family_aggregation_checked: input.family_aggregation_checked,
          control_agreements: input.control_agreements,
          ends: toEnd.map((r) => r.party_id),
          adds: toAdd,
          changed,
          files_with_bolagsverket: changed,
        },
      }
    }

    const { data: assessment, error } = await ctx.supabase
      .from('beneficial_owner_assessments')
      .insert({
        company_id: ctx.companyId,
        assessed_on: input.assessed_on,
        basis,
        conclusion: input.conclusion,
        owners,
        family_aggregation_checked: input.family_aggregation_checked,
        family_note: input.family_note?.trim() || null,
        control_agreements: input.control_agreements,
        control_note: input.control_note?.trim() || null,
        changed,
        assessed_by: ctx.userId,
      })
      .select('id')
      .single()
    if (error) throw new Error(`beneficial_owner_assessments insert failed: ${error.message}`)
    const assessmentId = (assessment as { id: string }).id

    const endedIds: string[] = []
    for (const r of toEnd) {
      const end = r.valid_from && r.valid_from >= input.assessed_on ? r.valid_from : dayBefore(input.assessed_on)
      const { error: endError } = await ctx.supabase
        .from('company_roles')
        .update({ valid_to: end, details: { ...(r.details ?? {}), ended_by_assessment_id: assessmentId } })
        .eq('company_id', ctx.companyId)
        .eq('id', r.id)
        .is('valid_to', null)
      if (endError) throw new Error(`company_roles update failed: ${endError.message}`)
      endedIds.push(r.id)
    }
    const addedIds: string[] = []
    for (const partyId of toAdd) {
      const o = owners.find((x) => x.party_id === partyId)!
      const { data: inserted, error: insertError } = await ctx.supabase
        .from('company_roles')
        .insert({
          company_id: ctx.companyId,
          party_id: partyId,
          role: 'verklig_huvudman',
          valid_from: input.assessed_on,
          source: 'person',
          details: { extent: o.extent, control: o.control, votes_pct: o.votes_pct, capital_pct: o.capital_pct, assessment_id: assessmentId },
          created_by: ctx.userId,
        })
        .select('id')
        .single()
      if (insertError) throw new Error(`company_roles insert failed: ${insertError.message}`)
      addedIds.push((inserted as { id: string }).id)
    }

    let sourceKey: string | null = null
    if (changed) {
      sourceKey = beneficialOwnerReminderKey(assessmentId)
      const due = input.assessed_on < today ? today : input.assessed_on
      const { error: deadlineError } = await createServiceClient().from('deadlines').insert({
        company_id: ctx.companyId,
        user_id: null,
        title: 'Anmäl verklig huvudman till Bolagsverket',
        due_date: due,
        deadline_type: 'other',
        priority: 'important',
        is_completed: false,
        source: 'system',
        status: 'action_needed',
        status_changed_at: new Date().toISOString(),
        notes:
          `Uppgifterna om verkliga huvudmän ändrades vid utredningen ${input.assessed_on}. ` +
          `Ändringen ska anmälas till Bolagsverket utan dröjsmål (2 kap. 3 § lagen om registrering av verkliga huvudmän). ` +
          `En behörig företrädare anmäler i Bolagsverkets e-tjänst: ${BENEFICIAL_OWNER_FILING_URL}`,
        is_auto_generated: true,
        reminder_offsets: [7, 1, 0],
        source_key: sourceKey,
      })
      // The record stands without the reminder: log, do not fail.
      if (deadlineError) ctx.log.warn('[bolaget] beneficial owner deadline insert failed', { companyId: ctx.companyId, error: deadlineError.message })
    }

    return {
      ok: true,
      data: {
        beneficial_owner_assessment_id: assessmentId,
        changed,
        ended_role_ids: endedIds,
        added_role_ids: addedIds,
        deadline_source_key: sourceKey,
        filing_url: BENEFICIAL_OWNER_FILING_URL,
      },
      created: true,
    }
  } catch (error) {
    return bolagetFailure(error)
  }
}
