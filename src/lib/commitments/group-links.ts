import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { isEntityType, preparesArsredovisning } from '@/lib/company/entity-type'
import type { OperationOutcome } from '@/lib/operations/types'
import { checkReferences, type CommitmentsContext } from './agreements'
import type { CreateGroupLinkInput, UpdateGroupLinkInput } from './schemas'
import type { GroupLinkView, GroupRelation } from './types'

/**
 * The group structure (company_group_links): the parent, the subsidiaries
 * and the associates, with ownership and votes over time and the 13xx
 * account each holding is booked on. For the forms that prepare an
 * årsredovisning (the koncernförhållanden note); an enskild firma is not a
 * group company. Consolidation (K3, koncernredovisning) is not here.
 */
const UNAVAILABLE = { ok: false as const, code: 'COMMITMENTS_UNAVAILABLE' }

export interface GroupLinkRow {
  id: string
  company_id: string
  relation: GroupRelation
  counterparty_name: string
  counterparty_org_number: string | null
  counterparty_registered_office: string | null
  party_id: string | null
  ownership_percent: number | string | null
  voting_percent: number | string | null
  valid_from: string | null
  valid_to: string | null
  bas_account: string | null
  linked_company_id: string | null
  notes: string | null
}

export function groupLinkView(row: GroupLinkRow): GroupLinkView {
  return {
    group_link_id: row.id,
    relation: row.relation,
    counterparty_name: row.counterparty_name,
    counterparty_org_number: row.counterparty_org_number,
    counterparty_registered_office: row.counterparty_registered_office,
    party_id: row.party_id,
    ownership_percent: row.ownership_percent == null ? null : Number(row.ownership_percent),
    voting_percent: row.voting_percent == null ? null : Number(row.voting_percent),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    bas_account: row.bas_account,
    linked_company_id: row.linked_company_id,
    notes: row.notes,
  }
}

/** Whether the company's legal form has a group structure to register: the forms that prepare an årsredovisning. */
export async function groupStructureApplies(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase.from('companies').select('entity_type').eq('id', companyId).maybeSingle()
  if (error) throw error
  const entityType = (data as { entity_type?: unknown } | null)?.entity_type
  return isEntityType(entityType) && preparesArsredovisning(entityType)
}

export async function loadGroupLinkRows(ctx: Pick<CommitmentsContext, 'supabase' | 'companyId'>): Promise<GroupLinkRow[]> {
  return fetchAllRows<GroupLinkRow>((range) =>
    ctx.supabase
      .from('company_group_links')
      .select('id, company_id, relation, counterparty_name, counterparty_org_number, counterparty_registered_office, party_id, ownership_percent, voting_percent, valid_from, valid_to, bas_account, linked_company_id, notes')
      .eq('company_id', ctx.companyId)
      .order('relation', { ascending: true })
      .order('counterparty_name', { ascending: true })
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
}

export async function listGroupLinks(ctx: CommitmentsContext): Promise<OperationOutcome<{ group_links: GroupLinkView[]; applies: boolean }>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const [rows, applies] = await Promise.all([loadGroupLinkRows(ctx), groupStructureApplies(ctx.supabase, ctx.companyId)])
  return { ok: true, data: { group_links: rows.map(groupLinkView), applies } }
}

/** The linked company is another company in the caller's team. */
async function checkLinkedCompany(ctx: CommitmentsContext, linkedCompanyId: string | null | undefined): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  if (!linkedCompanyId) return null
  if (linkedCompanyId === ctx.companyId) return { ok: false, code: 'GROUP_LINK_COMPANY_NOT_IN_TEAM' }
  const { data, error } = await ctx.supabase.from('companies').select('id, team_id').in('id', [ctx.companyId, linkedCompanyId])
  if (error) throw error
  const rows = (data ?? []) as Array<{ id: string; team_id: string | null }>
  const own = rows.find((r) => r.id === ctx.companyId)
  const other = rows.find((r) => r.id === linkedCompanyId)
  if (!own?.team_id || !other?.team_id || own.team_id !== other.team_id) return { ok: false, code: 'GROUP_LINK_COMPANY_NOT_IN_TEAM' }
  return null
}

interface GroupLinkColumns {
  relation?: GroupRelation
  counterparty_name?: string
  counterparty_org_number?: string | null
  counterparty_registered_office?: string | null
  party_id?: string | null
  ownership_percent?: number | null
  voting_percent?: number | null
  valid_from?: string | null
  valid_to?: string | null
  bas_account?: string | null
  linked_company_id?: string | null
  notes?: string | null
}

/** The columns an input sets; an absent field stays undefined (left alone), a blank text becomes null. */
function columnsFrom(input: Partial<CreateGroupLinkInput>): GroupLinkColumns {
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v || null)
  return {
    relation: input.relation,
    counterparty_name: input.counterparty_name,
    counterparty_org_number: text(input.counterparty_org_number),
    counterparty_registered_office: text(input.counterparty_registered_office),
    party_id: input.party_id,
    ownership_percent: input.ownership_percent,
    voting_percent: input.voting_percent,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    bas_account: text(input.bas_account),
    linked_company_id: input.linked_company_id,
    notes: text(input.notes),
  }
}

const setColumns = (columns: GroupLinkColumns): Record<string, unknown> =>
  Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined))

async function gate(ctx: CommitmentsContext): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  if (!(await groupStructureApplies(ctx.supabase, ctx.companyId))) return { ok: false, code: 'GROUP_LINKS_NOT_FOR_LEGAL_FORM' }
  return null
}

export async function createGroupLink(
  ctx: CommitmentsContext,
  input: CreateGroupLinkInput,
  opts: { dryRun: boolean },
): Promise<OperationOutcome<GroupLinkView>> {
  const refusedGate = await gate(ctx)
  if (refusedGate) return refusedGate
  const refused =
    (await checkReferences(ctx, { party_id: { field: 'party_id', id: input.party_id } })) ?? (await checkLinkedCompany(ctx, input.linked_company_id))
  if (refused) return refused
  const columns = columnsFrom(input)
  if (opts.dryRun) return { ok: true, dryRun: true, preview: { action: 'create', group_link: setColumns(columns) } }
  const { data, error } = await ctx.supabase
    .from('company_group_links')
    .insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      relation: columns.relation,
      counterparty_name: columns.counterparty_name,
      counterparty_org_number: columns.counterparty_org_number,
      counterparty_registered_office: columns.counterparty_registered_office,
      party_id: columns.party_id,
      ownership_percent: columns.ownership_percent,
      voting_percent: columns.voting_percent,
      valid_from: columns.valid_from,
      valid_to: columns.valid_to,
      bas_account: columns.bas_account,
      linked_company_id: columns.linked_company_id,
      notes: columns.notes,
    })
    .select('id, company_id, relation, counterparty_name, counterparty_org_number, counterparty_registered_office, party_id, ownership_percent, voting_percent, valid_from, valid_to, bas_account, linked_company_id, notes')
    .single()
  if (error) throw error
  return { ok: true, created: true, data: groupLinkView(data as GroupLinkRow) }
}

export async function updateGroupLink(
  ctx: CommitmentsContext,
  id: string,
  input: UpdateGroupLinkInput,
  opts: { dryRun: boolean },
): Promise<OperationOutcome<GroupLinkView>> {
  const refusedGate = await gate(ctx)
  if (refusedGate) return refusedGate
  const { data: existingData, error: readError } = await ctx.supabase
    .from('company_group_links')
    .select('id, company_id, relation, counterparty_name, counterparty_org_number, counterparty_registered_office, party_id, ownership_percent, voting_percent, valid_from, valid_to, bas_account, linked_company_id, notes')
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .maybeSingle()
  if (readError) throw readError
  const existing = existingData as GroupLinkRow | null
  if (!existing) return { ok: false, code: 'GROUP_LINK_NOT_FOUND' }
  const refused =
    (await checkReferences(ctx, { party_id: { field: 'party_id', id: input.party_id } })) ?? (await checkLinkedCompany(ctx, input.linked_company_id))
  if (refused) return refused
  const columns = columnsFrom(input)
  const changes = setColumns(columns)
  const validFrom = columns.valid_from !== undefined ? columns.valid_from : existing.valid_from
  const validTo = columns.valid_to !== undefined ? columns.valid_to : existing.valid_to
  if (validFrom && validTo && validTo < validFrom) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Slutdatumet ligger före startdatumet.', details: { field: 'valid_to' } }
  }
  if (opts.dryRun) return { ok: true, dryRun: true, preview: { action: 'update', group_link_id: id, changes } }
  if (Object.keys(changes).length === 0) return { ok: true, data: groupLinkView(existing) }
  const { data, error } = await ctx.supabase
    .from('company_group_links')
    .update({
      relation: columns.relation,
      counterparty_name: columns.counterparty_name,
      counterparty_org_number: columns.counterparty_org_number,
      counterparty_registered_office: columns.counterparty_registered_office,
      party_id: columns.party_id,
      ownership_percent: columns.ownership_percent,
      voting_percent: columns.voting_percent,
      valid_from: columns.valid_from,
      valid_to: columns.valid_to,
      bas_account: columns.bas_account,
      linked_company_id: columns.linked_company_id,
      notes: columns.notes,
    })
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .select('id, company_id, relation, counterparty_name, counterparty_org_number, counterparty_registered_office, party_id, ownership_percent, voting_percent, valid_from, valid_to, bas_account, linked_company_id, notes')
    .single()
  if (error) throw error
  return { ok: true, data: groupLinkView(data as GroupLinkRow) }
}
