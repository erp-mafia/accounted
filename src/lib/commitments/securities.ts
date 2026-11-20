import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { todayIso } from '@/lib/arkiv/agreements/dates'
import type { OperationOutcome } from '@/lib/operations/types'
import { checkReferences, type CommitmentsContext } from './agreements'
import { securityNoteTexts, type RegisterNoteTexts } from './note-text'
import type { CreateSecurityInput, UpdateSecurityInput } from './schemas'
import { isPledgedSecurity, type SecurityKind, type SecurityView } from './types'

/**
 * The register of ställda säkerheter and eventualförpliktelser
 * (securities_and_contingencies). Rows are dated, never deleted: a released
 * security gets valid_to. The årsredovisning note text is generated from the
 * rows that hold on the balance date (note-text.ts).
 */
const UNAVAILABLE = { ok: false as const, code: 'COMMITMENTS_UNAVAILABLE' }

export interface SecurityRow {
  id: string
  company_id: string
  kind: SecurityKind
  description: string
  amount: number | string
  in_favour_of_party_id: string | null
  in_favour_of_name: string | null
  for_group_company: boolean
  agreement_id: string | null
  valid_from: string | null
  valid_to: string | null
  document_id: string | null
  notes: string | null
}

export function securityView(row: SecurityRow): SecurityView {
  return {
    security_id: row.id,
    kind: row.kind,
    pledged: isPledgedSecurity(row.kind),
    description: row.description,
    amount: Number(row.amount),
    in_favour_of_party_id: row.in_favour_of_party_id,
    in_favour_of_name: row.in_favour_of_name,
    for_group_company: row.for_group_company,
    agreement_id: row.agreement_id,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    document_id: row.document_id,
    notes: row.notes,
  }
}

export async function loadSecurityRows(ctx: Pick<CommitmentsContext, 'supabase' | 'companyId'>): Promise<SecurityRow[]> {
  return fetchAllRows<SecurityRow>((range) =>
    ctx.supabase
      .from('securities_and_contingencies')
      .select('id, company_id, kind, description, amount, in_favour_of_party_id, in_favour_of_name, for_group_company, agreement_id, valid_from, valid_to, document_id, notes')
      .eq('company_id', ctx.companyId)
      .order('kind', { ascending: true })
      .order('valid_from', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
}

export async function listSecurities(
  ctx: CommitmentsContext,
  opts: { balance_date?: string } = {},
): Promise<OperationOutcome<{ securities: SecurityView[]; balance_date: string; note_texts: Pick<RegisterNoteTexts, 'securities_pledged' | 'contingent_liabilities'> }>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const balanceDate = opts.balance_date ?? todayIso()
  const rows = await loadSecurityRows(ctx)
  return {
    ok: true,
    data: { securities: rows.map(securityView), balance_date: balanceDate, note_texts: securityNoteTexts(rows, balanceDate) },
  }
}

interface SecurityColumns {
  kind?: SecurityKind
  description?: string
  amount?: number
  in_favour_of_name?: string | null
  in_favour_of_party_id?: string | null
  for_group_company?: boolean
  agreement_id?: string | null
  valid_from?: string | null
  valid_to?: string | null
  document_id?: string | null
  notes?: string | null
}

/** The columns an input sets; an absent field stays undefined (left alone), a blank text becomes null. */
function columnsFrom(input: Partial<CreateSecurityInput>): SecurityColumns {
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v || null)
  return {
    kind: input.kind,
    description: input.description,
    amount: input.amount === undefined ? undefined : roundOre(input.amount),
    in_favour_of_name: text(input.in_favour_of_name),
    in_favour_of_party_id: input.in_favour_of_party_id,
    for_group_company: input.for_group_company,
    agreement_id: input.agreement_id,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    document_id: input.document_id,
    notes: text(input.notes),
  }
}

const setColumns = (columns: SecurityColumns): Record<string, unknown> =>
  Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined))

async function findSecurity(ctx: CommitmentsContext, id: string): Promise<SecurityRow | null> {
  const { data, error } = await ctx.supabase
    .from('securities_and_contingencies')
    .select('id, company_id, kind, description, amount, in_favour_of_party_id, in_favour_of_name, for_group_company, agreement_id, valid_from, valid_to, document_id, notes')
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return (data as SecurityRow | null) ?? null
}

export async function createSecurity(
  ctx: CommitmentsContext,
  input: CreateSecurityInput,
  opts: { dryRun: boolean },
): Promise<OperationOutcome<SecurityView>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const refused = await checkReferences(ctx, {
    party_id: { field: 'in_favour_of_party_id', id: input.in_favour_of_party_id },
    document_id: input.document_id,
    agreement_id: input.agreement_id,
  })
  if (refused) return refused
  const columns = columnsFrom(input)
  if (opts.dryRun) {
    return { ok: true, dryRun: true, preview: { action: 'create', security: { ...setColumns(columns), pledged: isPledgedSecurity(input.kind) } } }
  }
  const { data, error } = await ctx.supabase
    .from('securities_and_contingencies')
    .insert({
      company_id: ctx.companyId,
      user_id: ctx.userId,
      kind: columns.kind,
      description: columns.description,
      amount: columns.amount,
      in_favour_of_name: columns.in_favour_of_name,
      in_favour_of_party_id: columns.in_favour_of_party_id,
      for_group_company: columns.for_group_company,
      agreement_id: columns.agreement_id,
      valid_from: columns.valid_from,
      valid_to: columns.valid_to,
      document_id: columns.document_id,
      notes: columns.notes,
    })
    .select('id, company_id, kind, description, amount, in_favour_of_party_id, in_favour_of_name, for_group_company, agreement_id, valid_from, valid_to, document_id, notes')
    .single()
  if (error) throw error
  return { ok: true, created: true, data: securityView(data as SecurityRow) }
}

export async function updateSecurity(
  ctx: CommitmentsContext,
  id: string,
  input: UpdateSecurityInput,
  opts: { dryRun: boolean },
): Promise<OperationOutcome<SecurityView>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const existing = await findSecurity(ctx, id)
  if (!existing) return { ok: false, code: 'SECURITY_NOT_FOUND' }
  const refused = await checkReferences(ctx, {
    party_id: { field: 'in_favour_of_party_id', id: input.in_favour_of_party_id },
    document_id: input.document_id,
    agreement_id: input.agreement_id,
  })
  if (refused) return refused
  const columns = columnsFrom(input)
  const changes = setColumns(columns)
  const validFrom = columns.valid_from !== undefined ? columns.valid_from : existing.valid_from
  const validTo = columns.valid_to !== undefined ? columns.valid_to : existing.valid_to
  if (validFrom && validTo && validTo < validFrom) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Slutdatumet ligger före startdatumet.', details: { field: 'valid_to' } }
  }
  if (opts.dryRun) return { ok: true, dryRun: true, preview: { action: 'update', security_id: id, changes } }
  if (Object.keys(changes).length === 0) return { ok: true, data: securityView(existing) }
  const { data, error } = await ctx.supabase
    .from('securities_and_contingencies')
    .update({
      kind: columns.kind,
      description: columns.description,
      amount: columns.amount,
      in_favour_of_name: columns.in_favour_of_name,
      in_favour_of_party_id: columns.in_favour_of_party_id,
      for_group_company: columns.for_group_company,
      agreement_id: columns.agreement_id,
      valid_from: columns.valid_from,
      valid_to: columns.valid_to,
      document_id: columns.document_id,
      notes: columns.notes,
    })
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .select('id, company_id, kind, description, amount, in_favour_of_party_id, in_favour_of_name, for_group_company, agreement_id, valid_from, valid_to, document_id, notes')
    .single()
  if (error) throw error
  return { ok: true, data: securityView(data as SecurityRow) }
}
