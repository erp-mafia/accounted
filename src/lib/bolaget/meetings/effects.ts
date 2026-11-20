/**
 * Decisions take effect in the registers: an adopted val_styrelse or
 * val_revisor ends and adds roles (company_roles) through the roles service,
 * each row carrying the decision (source 'decision', decision_id; an ended
 * row details.ended_by_decision_id).
 *
 * When: as the minutes are signed (by hand or when the BankID request
 * completes), before the meeting turns signed. Until then the minutes can
 * still change, so the effects are a preview; the signed minutes are the
 * record they rest on. The dates do not depend on that moment: a new role
 * starts on the meeting day and an ended one ends the day before, so the
 * roles' history is the same whenever the justering happens. Applying is
 * idempotent: a re-run finds the new roles in office and plans nothing.
 */
import type { OperationContext, OperationWarning } from '@/lib/operations/types'
import { addCompanyRole, endCompanyRole, loadRoles, type RolesView } from '../roles'
import { ROLE_LABELS_SV } from '../types'
import { changingEffects, planRoleEffects, type DecisionShape, type RoleEffect, type RoleShape } from './rules'
import { MEETING_KIND_LABELS_SV, type MeetingKind } from './types'

export interface AppliedRole {
  company_role_id: string
  decision_id: string
  party_id: string
  name: string
  role: string
  role_label: string
  date: string | null
}

export interface RegisterEffectsView {
  /** Adds and ends the adopted elections still make (before signing). */
  planned: RoleEffect[]
  /** Who simply continues. */
  kept: RoleEffect[]
  /** What the decisions already did to the roles. */
  applied: { added: AppliedRole[]; ended: AppliedRole[] }
}

export function roleShapes(roles: RolesView): RoleShape[] {
  return roles.roles.map((r) => ({ id: r.id, party_id: r.party_id, role: r.role, valid_from: r.valid_from, valid_to: r.valid_to, name: r.party?.name ?? null }))
}

/** The planned and applied effects of a meeting's decisions on the roles. */
export function registerEffectsFrom(roles: RolesView, decisions: readonly DecisionShape[], meetingDate: string): RegisterEffectsView {
  const all = planRoleEffects(decisions, roleShapes(roles), meetingDate)
  const ids = new Set(decisions.map((d) => d.id))
  const added: AppliedRole[] = []
  const ended: AppliedRole[] = []
  for (const r of roles.roles) {
    const base = { company_role_id: r.id, party_id: r.party_id, name: r.party?.name ?? 'okänd', role: r.role, role_label: ROLE_LABELS_SV[r.role] }
    if (r.decision_id && ids.has(r.decision_id)) added.push({ ...base, decision_id: r.decision_id, date: r.valid_from })
    const endedBy = (r.details ?? {}).ended_by_decision_id
    if (typeof endedBy === 'string' && ids.has(endedBy)) ended.push({ ...base, decision_id: endedBy, date: r.valid_to })
  }
  return { planned: changingEffects(all), kept: all.filter((e) => e.action === 'keep'), applied: { added, ended } }
}

/** Whether the decisions change (or changed) who holds a role: what Bolagsverket must be told. */
export function changesRoles(view: RegisterEffectsView): boolean {
  return view.planned.length > 0 || view.applied.added.length > 0 || view.applied.ended.length > 0
}

export type ApplyOutcome =
  | { ok: true; added: string[]; ended: string[]; warnings: OperationWarning[] }
  | { ok: false; code: string; messageSv?: string; details?: Record<string, unknown> }

/**
 * Apply the adopted elections to the roles. Stops at the first refusal (the
 * caller keeps the minutes unsigned, so a retry picks up where it stopped).
 * A person already holding the role is a warning, not a failure.
 */
export async function applyRegisterEffects(
  ctx: OperationContext,
  meeting: { id: string; kind: MeetingKind; meeting_date: string },
  decisions: readonly DecisionShape[],
): Promise<ApplyOutcome> {
  if (!decisions.some((d) => d.outcome === 'bifallen' && (d.kind === 'val_styrelse' || d.kind === 'val_revisor'))) {
    return { ok: true, added: [], ended: [], warnings: [] }
  }
  const roles = await loadRoles(ctx, meeting.meeting_date)
  const plan = registerEffectsFrom(roles, decisions, meeting.meeting_date).planned
  const reason = `${MEETING_KIND_LABELS_SV[meeting.kind]} ${meeting.meeting_date}`
  const added: string[] = []
  const ended: string[] = []
  const warnings: OperationWarning[] = []
  // Ends first: a member who moves from ledamot to ordförande leaves one row and gets the other.
  for (const e of plan.filter((x) => x.action === 'end')) {
    const outcome = await endCompanyRole(ctx, { company_role_id: e.company_role_id!, valid_to: e.date, reason, decision_id: e.decision_id }, { dryRun: false })
    if (!outcome.ok) {
      if (outcome.code === 'COMPANY_ROLE_ALREADY_ENDED') continue
      return outcome
    }
    if (!outcome.dryRun) ended.push(outcome.data.company_role_id)
  }
  for (const e of plan.filter((x) => x.action === 'add')) {
    const outcome = await addCompanyRole(
      ctx,
      {
        party: e.party_id ? { party_id: e.party_id } : { name: e.name, kind: e.kind, org_number: e.org_number },
        role: e.role,
        valid_from: e.date,
        source: 'decision',
        decision_id: e.decision_id,
        details: { meeting_id: meeting.id },
      },
      { dryRun: false },
    )
    if (!outcome.ok) {
      if (outcome.code === 'COMPANY_ROLE_DUPLICATE') {
        warnings.push({
          code: 'COMPANY_ROLE_DUPLICATE',
          message_sv: `${e.name} har redan rollen ${ROLE_LABELS_SV[e.role].toLowerCase()}; ingen ny rad lades till.`,
          message_en: `${e.name} already holds the role ${e.role}; no new row was added.`,
        })
        continue
      }
      return outcome
    }
    if (!outcome.dryRun) added.push(outcome.data.company_role_id)
  }
  return { ok: true, added, ended, warnings }
}
