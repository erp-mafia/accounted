/**
 * Roles over time (ABL 8 kap.): who sits on the board, who is VD, who signs
 * for the company, who audits it, who the verkliga huvudmän are. A role is
 * end-dated, never deleted (company_roles_guard); the firmateckning text is
 * kept the same way (company_signatory_rules).
 *
 * The first read for a company with no roles seeds them from the registry
 * snapshot it already has (companies.tic_snapshot): no registry call, and
 * once only (share_register_settings.roles_seeded_at is the claim).
 */
import { createServiceClient } from '@/lib/supabase/server'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { ensureRegisterParty, loadRegisterParties, PartyRefError, checkPartyRef, type PartyRef } from './people'
import { rolesFromTicSnapshot, signatoryRulesFromTicSnapshot } from './tic-seed'
import {
  BOARD_MEMBER_ROLES,
  ROLE_LABELS_SV,
  type CompanyRole,
  type CompanyRoleKind,
  type RegisterParty,
  type RoleSource,
  type SignatoryRule,
} from './types'
import { bolagetFailure } from './errors'

/** Whether a dated row holds on `asOf` (an unknown start counts as held). */
export function activeOn(row: { valid_from: string | null; valid_to: string | null }, asOf: string): boolean {
  return (row.valid_from === null || row.valid_from <= asOf) && (row.valid_to === null || row.valid_to >= asOf)
}

/** The day before an ISO date. */
export function dayBefore(iso: string): string {
  return addDaysIso(iso, -1)
}

/**
 * Seed company_roles and company_signatory_rules from companies.tic_snapshot
 * when the company has no roles yet. Service role (a viewer's read may be
 * the first); best-effort: a failure leaves the company unseeded and the
 * next read tries again. Returns how many roles were written.
 */
export async function seedRolesFromSnapshot(ctx: OperationContext): Promise<number> {
  const { companyId } = ctx
  const service = createServiceClient()
  const { count, error: countError } = await service
    .from('company_roles')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (countError || (count ?? 0) > 0) return 0

  const { data: company, error: companyError } = await service
    .from('companies')
    .select('tic_snapshot')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError || !company) return 0
  const snapshot = (company as { tic_snapshot: unknown }).tic_snapshot
  const roles = rolesFromTicSnapshot(snapshot)
  const rules = signatoryRulesFromTicSnapshot(snapshot)
  if (roles.length === 0 && rules.length === 0) return 0

  // The claim: exactly one read seeds.
  await service.from('share_register_settings').upsert({ company_id: companyId }, { onConflict: 'company_id', ignoreDuplicates: true })
  const { data: claimed } = await service
    .from('share_register_settings')
    .update({ roles_seeded_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .is('roles_seeded_at', null)
    .select('company_id')
  if (!claimed || claimed.length === 0) return 0

  const serviceCtx: OperationContext = { ...ctx, supabase: service }
  const partyByName = new Map<string, string>()
  let seeded = 0
  for (const r of roles) {
    const key = r.name.toLowerCase()
    let partyId = partyByName.get(key)
    if (!partyId) {
      partyId = await ensureRegisterParty(serviceCtx, { name: r.name, kind: r.kind })
      partyByName.set(key, partyId)
    }
    const { error } = await service.from('company_roles').insert({
      company_id: companyId,
      party_id: partyId,
      role: r.role,
      valid_from: r.valid_from,
      valid_to: r.valid_to && r.valid_from && r.valid_to < r.valid_from ? r.valid_from : r.valid_to,
      source: 'registry_tic',
      details: r.position ? { registry_position: r.position } : {},
    })
    if (error) throw new Error(`company_roles seed failed: ${error.message}`)
    seeded += 1
  }
  for (const rule_text of rules) {
    const { error } = await service.from('company_signatory_rules').insert({ company_id: companyId, rule_text, source: 'registry_tic' })
    if (error) throw new Error(`company_signatory_rules seed failed: ${error.message}`)
  }
  return seeded
}

export interface RoleView extends CompanyRole {
  party: RegisterParty | null
  label_sv: string
  active: boolean
}

export interface RolesView {
  as_of: string
  roles: RoleView[]
  signatory_rules: Array<SignatoryRule & { active: boolean }>
  /** The firmateckning in force on as_of. */
  signatory_rule: string | null
  board: RoleView[]
  ceo: RoleView | null
}

/**
 * The roles and firmateckning, every row with whether it holds on `asOf`.
 * Seeds from the snapshot first when the company has none.
 */
export async function loadRoles(ctx: OperationContext, asOf: string | null = null): Promise<RolesView> {
  const day = asOf ?? todayIsoStockholm()
  try {
    await seedRolesFromSnapshot(ctx)
  } catch (error) {
    ctx.log.warn('[bolaget] roles seed from snapshot failed', { companyId: ctx.companyId, error: String(error) })
  }
  const [rolesRes, rulesRes] = await Promise.all([
    ctx.supabase.from('company_roles').select('id, party_id, role, valid_from, valid_to, source, decision_id, registered_at, details, created_at').eq('company_id', ctx.companyId).order('valid_from', { ascending: true, nullsFirst: true }).order('created_at'),
    ctx.supabase.from('company_signatory_rules').select('id, rule_text, valid_from, valid_to, source, registered_at').eq('company_id', ctx.companyId).order('valid_from', { ascending: true, nullsFirst: true }).order('created_at'),
  ])
  if (rolesRes.error) throw new Error(`company_roles read failed: ${rolesRes.error.message}`)
  if (rulesRes.error) throw new Error(`company_signatory_rules read failed: ${rulesRes.error.message}`)
  const roleRows = (rolesRes.data ?? []) as CompanyRole[]
  const parties = await loadRegisterParties(ctx.companyId, roleRows.map((r) => r.party_id))
  const roles: RoleView[] = roleRows.map((r) => ({
    ...r,
    details: r.details ?? {},
    party: parties.get(r.party_id) ?? null,
    label_sv: ROLE_LABELS_SV[r.role],
    active: activeOn(r, day),
  }))
  const rules = ((rulesRes.data ?? []) as SignatoryRule[]).map((r) => ({ ...r, active: activeOn(r, day) }))
  const activeRules = rules.filter((r) => r.active)
  return {
    as_of: day,
    roles,
    signatory_rules: rules,
    signatory_rule: activeRules.length > 0 ? activeRules.map((r) => r.rule_text).join(' ') : null,
    board: roles.filter((r) => r.active && BOARD_MEMBER_ROLES.includes(r.role)),
    ceo: roles.find((r) => r.active && r.role === 'vd') ?? null,
  }
}

export interface AddRoleInput {
  party: PartyRef
  role: CompanyRoleKind
  valid_from: string | null
  valid_to?: string | null
  registered_at?: string | null
  source?: RoleSource
  decision_id?: string | null
  details?: Record<string, unknown>
}

/** Add a role (dry-runnable). The same person can hold several roles; the same role twice at once is refused. */
export async function addCompanyRole(
  ctx: OperationContext,
  input: AddRoleInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<{ company_role_id: string; party_id: string; role: CompanyRoleKind; valid_from: string | null }>> {
  try {
    checkPartyRef(input.party, 'personen')
    if (input.valid_to && input.valid_from && input.valid_to < input.valid_from) return { ok: false, code: 'BOLAGET_DATES_INVALID' }
    if (input.party.party_id) {
      const { data: same, error } = await ctx.supabase
        .from('company_roles')
        .select('id, valid_from, valid_to')
        .eq('company_id', ctx.companyId)
        .eq('party_id', input.party.party_id)
        .eq('role', input.role)
      if (error) throw new Error(`company_roles read failed: ${error.message}`)
      const from = input.valid_from ?? '0000-01-01'
      const clash = ((same ?? []) as Array<{ valid_from: string | null; valid_to: string | null }>).some(
        (r) => r.valid_to === null || r.valid_to >= from,
      )
      if (clash) return { ok: false, code: 'COMPANY_ROLE_DUPLICATE' }
    }
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          party: input.party.party_id ? { party_id: input.party.party_id } : { name: input.party.name, kind: input.party.kind ?? 'person' },
          role: input.role,
          role_label: ROLE_LABELS_SV[input.role],
          valid_from: input.valid_from,
          valid_to: input.valid_to ?? null,
        },
      }
    }
    const partyId = await ensureRegisterParty(ctx, input.party)
    const { data, error } = await ctx.supabase
      .from('company_roles')
      .insert({
        company_id: ctx.companyId,
        party_id: partyId,
        role: input.role,
        valid_from: input.valid_from,
        valid_to: input.valid_to ?? null,
        registered_at: input.registered_at ?? null,
        source: input.source ?? 'person',
        decision_id: input.decision_id ?? null,
        details: input.details ?? {},
        created_by: ctx.userId,
      })
      .select('id')
      .single()
    if (error) throw new Error(`company_roles insert failed: ${error.message}`)
    return { ok: true, data: { company_role_id: (data as { id: string }).id, party_id: partyId, role: input.role, valid_from: input.valid_from }, created: true }
  } catch (error) {
    return bolagetFailure(error)
  }
}

/** End a role on a date (dry-runnable). An ended role cannot be ended again. */
export async function endCompanyRole(
  ctx: OperationContext,
  input: { company_role_id: string; valid_to: string; reason?: string | null; decision_id?: string | null },
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<{ company_role_id: string; valid_to: string }>> {
  try {
    const { data: row, error } = await ctx.supabase
      .from('company_roles')
      .select('id, party_id, role, valid_from, valid_to, source, decision_id, registered_at, details, created_at')
      .eq('company_id', ctx.companyId)
      .eq('id', input.company_role_id)
      .maybeSingle()
    if (error) throw new Error(`company_roles read failed: ${error.message}`)
    if (!row) return { ok: false, code: 'COMPANY_ROLE_NOT_FOUND' }
    const role = row as CompanyRole
    if (role.valid_to !== null) return { ok: false, code: 'COMPANY_ROLE_ALREADY_ENDED' }
    if (role.valid_from && input.valid_to < role.valid_from) return { ok: false, code: 'BOLAGET_DATES_INVALID' }
    if (dryRun) {
      return { ok: true, dryRun: true, preview: { company_role_id: role.id, role: role.role, role_label: ROLE_LABELS_SV[role.role], valid_to: input.valid_to } }
    }
    // The decision that ended it (a stämma's election) rides in details: decision_id names the one that started it.
    const details =
      input.reason || input.decision_id
        ? {
            ...(role.details ?? {}),
            ...(input.reason ? { end_reason: input.reason } : {}),
            ...(input.decision_id ? { ended_by_decision_id: input.decision_id } : {}),
          }
        : role.details ?? {}
    const { error: updateError } = await ctx.supabase
      .from('company_roles')
      .update({ valid_to: input.valid_to, details })
      .eq('company_id', ctx.companyId)
      .eq('id', role.id)
      .is('valid_to', null)
    if (updateError) throw new Error(`company_roles update failed: ${updateError.message}`)
    return { ok: true, data: { company_role_id: role.id, valid_to: input.valid_to } }
  } catch (error) {
    return bolagetFailure(error)
  }
}

/**
 * Set the firmateckning from a date (dry-runnable): the rule in force ends
 * the day before, the new one starts.
 */
export async function setSignatoryRule(
  ctx: OperationContext,
  input: { rule_text: string; valid_from: string; registered_at?: string | null; source?: RoleSource; decision_id?: string | null },
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<{ signatory_rule_id: string; rule_text: string; valid_from: string; ended_rule_ids: string[] }>> {
  try {
    const text = input.rule_text.trim()
    if (!text) return { ok: false, code: 'VALIDATION_ERROR' }
    const { data, error } = await ctx.supabase
      .from('company_signatory_rules')
      .select('id, rule_text, valid_from, valid_to, source, registered_at')
      .eq('company_id', ctx.companyId)
      .is('valid_to', null)
    if (error) throw new Error(`company_signatory_rules read failed: ${error.message}`)
    const open = (data ?? []) as SignatoryRule[]
    if (open.some((r) => r.valid_from !== null && r.valid_from >= input.valid_from)) return { ok: false, code: 'BOLAGET_DATES_INVALID' }
    const endOn = dayBefore(input.valid_from)
    if (dryRun) {
      return { ok: true, dryRun: true, preview: { rule_text: text, valid_from: input.valid_from, ends: open.map((r) => ({ rule_text: r.rule_text, valid_to: endOn })) } }
    }
    for (const r of open) {
      const { error: endError } = await ctx.supabase
        .from('company_signatory_rules')
        .update({ valid_to: endOn })
        .eq('company_id', ctx.companyId)
        .eq('id', r.id)
        .is('valid_to', null)
      if (endError) throw new Error(`company_signatory_rules update failed: ${endError.message}`)
    }
    const { data: inserted, error: insertError } = await ctx.supabase
      .from('company_signatory_rules')
      .insert({
        company_id: ctx.companyId,
        rule_text: text,
        valid_from: input.valid_from,
        registered_at: input.registered_at ?? null,
        source: input.source ?? 'person',
        decision_id: input.decision_id ?? null,
        created_by: ctx.userId,
      })
      .select('id')
      .single()
    if (insertError) throw new Error(`company_signatory_rules insert failed: ${insertError.message}`)
    return {
      ok: true,
      data: { signatory_rule_id: (inserted as { id: string }).id, rule_text: text, valid_from: input.valid_from, ended_rule_ids: open.map((r) => r.id) },
      created: true,
    }
  } catch (error) {
    return bolagetFailure(error)
  }
}

/** The ids of the parties holding a board or VD role on a date (ABL 8:45). */
export function boardAndCeoPartyIds(roles: readonly Pick<RoleView, 'party_id' | 'role' | 'active'>[], kinds: readonly CompanyRoleKind[]): Set<string> {
  return new Set(roles.filter((r) => r.active && kinds.includes(r.role)).map((r) => r.party_id))
}

export { PartyRefError }
