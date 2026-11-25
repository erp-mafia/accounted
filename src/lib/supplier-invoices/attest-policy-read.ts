/**
 * Reading a company's attest policy (company_attest_policies), kept apart
 * from the attest service so the worklist and the payment paths read it
 * without loading the service's writers. The rules are attest-policy.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { DIM_PROJECT } from '@/lib/bookkeeping/dimension-resolver'
import {
  invoiceProjects,
  NO_ATTEST_POLICY,
  paymentWaitsForAttest,
  policyRoutesProjects,
  type AttestationRecord,
  type AttestInvoiceFacts,
  type AttestLimits,
  type AttestPolicy,
  type AttestSubstitution,
} from './attest-policy'
import { companyAttestsSupplierInvoices } from './lifecycle'

export const POLICY_COLUMNS = 'company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by, updated_at'
/**
 * The policy with its förattest and the substitutions that run on the given
 * day, in the one read the policy always was (migration 20261108180000);
 * POLICY_COLUMNS until that migration has run.
 */
const POLICY_STEP_COLUMNS = `${POLICY_COLUMNS}, pre_attesters, project_attesters, company_attest_substitutes(user_id, substitute_user_id)`

export interface PolicyRow {
  company_id: string
  enabled: boolean
  threshold_amount: number | string | null
  mode: 'any' | 'all'
  attesters: string[] | null
  preparer_may_attest: boolean
  two_step_from_sek?: number | string | null
  pre_attesters?: string[] | null
  project_attesters?: Record<string, string[]> | null
  /** The substitutions running today, embedded (loadAttestPolicy). */
  company_attest_substitutes?: AttestSubstitution[] | null
  updated_by: string | null
  updated_at: string | null
}

const toAmount = (value: number | string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value)

/** The förattest per project as saved: code to attesters, only codes with someone named. */
function toProjectAttesters(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [code, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids) && ids.length > 0) out[code] = ids.filter((id): id is string => typeof id === 'string')
  }
  return out
}

/**
 * The policy row as the rules read it. The förattest fields are set only
 * when the row names someone for them, so a company without förattest reads
 * exactly the policy it read before #192.
 */
export function toPolicy(row: PolicyRow | null): AttestPolicy {
  if (!row) return NO_ATTEST_POLICY
  const substitutes = (row.company_attest_substitutes ?? []).map((s) => ({ user_id: s.user_id, substitute_user_id: s.substitute_user_id }))
  const preAttesters = row.pre_attesters ?? []
  const projectAttesters = toProjectAttesters(row.project_attesters)
  return {
    enabled: row.enabled === true,
    threshold_amount: toAmount(row.threshold_amount),
    mode: row.mode === 'all' ? 'all' : 'any',
    attesters: row.attesters ?? [],
    preparer_may_attest: row.preparer_may_attest === true,
    two_step_from_sek: toAmount(row.two_step_from_sek),
    ...(preAttesters.length > 0 ? { pre_attesters: preAttesters } : {}),
    ...(Object.keys(projectAttesters).length > 0 ? { project_attesters: projectAttesters } : {}),
    ...(substitutes.length > 0 ? { substitutes } : {}),
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  }
}

/**
 * A column PostgREST does not know (42703 on a read, PGRST204 on a write).
 * Kept local, not lib/pending-operations/agent-reason: this module reaches
 * the Transaktioner client bundle through lib/worklist, and that one imports
 * node:async_hooks.
 */
function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204'
}

/** PostgREST knows no such column or relationship: the migration that adds it has not run yet (Vercel ships before it). */
function isMissingStepSchema(error: { code?: string } | null | undefined): boolean {
  return isMissingColumnError(error) || error?.code === 'PGRST200' || isMissingTableError(error)
}

/** The policy row with its förattest and today's substitutions, or the row as it was before them. */
async function loadPolicyRow(supabase: SupabaseClient, companyId: string, today: string): Promise<PolicyRow | null> {
  const withSteps = await supabase
    .from('company_attest_policies')
    .select(POLICY_STEP_COLUMNS)
    .eq('company_id', companyId)
    .lte('company_attest_substitutes.starts_on', today)
    .gte('company_attest_substitutes.ends_on', today)
    .maybeSingle()
  if (!isMissingStepSchema(withSteps.error)) {
    if (withSteps.error) throw withSteps.error
    return withSteps.data as unknown as PolicyRow | null
  }
  const { data, error } = await supabase.from('company_attest_policies').select(POLICY_COLUMNS).eq('company_id', companyId).maybeSingle()
  if (error) throw error
  return data as PolicyRow | null
}

/** A substitution with its period, as the settings and the API show it. */
export interface AttestSubstituteRow extends AttestSubstitution {
  id: string
  starts_on: string
  ends_on: string
  created_by: string | null
  created_at: string
}

/**
 * The company's substitutions that have not ended (today or later, Stockholm
 * dates), soonest first. Empty until the migration that adds them has run.
 * Throws on any other failed read.
 */
export async function loadAttestSubstitutes(supabase: SupabaseClient, companyId: string, today: string = todayIsoStockholm()): Promise<AttestSubstituteRow[]> {
  const { data, error } = await supabase
    .from('company_attest_substitutes')
    .select('id, user_id, substitute_user_id, starts_on, ends_on, created_by, created_at')
    .eq('company_id', companyId)
    .gte('ends_on', today)
    .order('starts_on', { ascending: true })
    .order('id', { ascending: true })
  if (isMissingTableError(error)) return []
  if (error) throw error
  return (data ?? []) as AttestSubstituteRow[]
}

/**
 * True when the company has its attest policy on: the half of
 * companyAttestsSupplierInvoices the accounting method does not answer. No
 * row reads as off. Throws on a failed read; each caller decides how it
 * degrades.
 */
export async function loadAttestPolicyOn(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase.from('company_attest_policies').select('enabled').eq('company_id', companyId).maybeSingle()
  if (error) throw error
  return (data as { enabled?: boolean | null } | null)?.enabled === true
}

/**
 * The company's attest policy, with its förattest and the substitutions that
 * run today (Stockholm); no row reads as no policy. One read, as before
 * #192. Throws on a failed read: payment must not read "no policy" from an
 * error.
 */
export async function loadAttestPolicy(supabase: SupabaseClient, companyId: string, today: string = todayIsoStockholm()): Promise<AttestPolicy> {
  return toPolicy(await loadPolicyRow(supabase, companyId, today))
}

/** A project (a value of dimension 6) as the förattest settings pick it. */
export interface AttestProjectValue {
  code: string
  name: string
  is_active: boolean
}

/**
 * The company's projects (dimension 6 values), by code; only `codes` when
 * given. Empty when the company has no project dimension. Throws on a
 * failed read.
 */
export async function loadProjectValues(supabase: SupabaseClient, companyId: string, codes?: readonly string[]): Promise<AttestProjectValue[]> {
  if (codes && codes.length === 0) return []
  const { data: dimension, error: dimensionError } = await supabase
    .from('dimensions')
    .select('id')
    .eq('company_id', companyId)
    .eq('sie_dim_no', Number(DIM_PROJECT))
    .maybeSingle()
  if (dimensionError) throw dimensionError
  const dimensionId = (dimension as { id: string } | null)?.id
  if (!dimensionId) return []
  const values: AttestProjectValue[] = []
  for (const part of codes ? chunk([...new Set(codes)], 150) : [null]) {
    const rows = await fetchAllRows<AttestProjectValue>(({ from, to }) => {
      const query = supabase
        .from('dimension_values')
        .select('code, name, is_active')
        .eq('company_id', companyId)
        .eq('dimension_id', dimensionId)
      return (part ? query.in('code', part) : query).order('code', { ascending: true }).range(from, to)
    })
    values.push(...rows)
  }
  return values
}

/** The names of projects by code, for the förattest's labels. */
export async function loadProjectNames(supabase: SupabaseClient, companyId: string, codes: readonly string[]): Promise<Map<string, string>> {
  return new Map((await loadProjectValues(supabase, companyId, codes)).map((v) => [v.code, v.name]))
}

/**
 * The projects of each invoice for the förattest (invoiceProjects): its
 * lines' dimension 6 merged over its own. Read only when the policy routes
 * projects; otherwise empty, and the invoices are judged as they are. Takes
 * ids, so a caller starts it beside its other reads once the policy is in.
 * Throws on a failed read.
 */
export async function loadInvoiceProjects(
  supabase: SupabaseClient,
  companyId: string,
  policy: AttestPolicy,
  invoiceIds: readonly string[],
): Promise<ReadonlyMap<string, Array<string | null>>> {
  const projects = new Map<string, Array<string | null>>()
  if (!policyRoutesProjects(policy) || invoiceIds.length === 0) return projects
  for (const part of chunk([...new Set(invoiceIds)], 150)) {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, default_dimensions, supplier_invoice_items(dimensions)')
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw error
    for (const row of (data ?? []) as Array<{ id: string; default_dimensions: unknown; supplier_invoice_items: Array<{ dimensions: unknown }> | null }>) {
      projects.set(row.id, invoiceProjects(row.default_dimensions, row.supplier_invoice_items ?? []))
    }
  }
  return projects
}

/** The policy, and the projects of `invoiceIds` read as soon as the policy says they matter: one step to start beside the other reads. */
export async function loadAttestPolicyWithProjects(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<{ policy: AttestPolicy; projects: ReadonlyMap<string, Array<string | null>> }> {
  const policy = await loadAttestPolicy(supabase, companyId)
  return { policy, projects: await loadInvoiceProjects(supabase, companyId, policy, invoiceIds) }
}

/** The invoice with its projects (loadInvoiceProjects), or as it is when the policy routes none. */
export function withProjects<T extends { id: string }>(invoice: T, projects: ReadonlyMap<string, Array<string | null>>): T & Pick<AttestInvoiceFacts, 'projects'> {
  const found = projects.get(invoice.id)
  return found ? { ...invoice, projects: found } : invoice
}

/** What a limit row covers: supplier invoices now; booking_review is reserved for the review step of one-click booking. */
export type AttestLimitScope = 'supplier_invoice' | 'booking_review'

/**
 * The attesters' limits for supplier invoices (company_attest_limits): user
 * id to limit in SEK, null = no limit. Someone without a row has no limit.
 * Throws on a failed read: a missing limit reads as no limit.
 */
export async function loadAttestLimits(supabase: SupabaseClient, companyId: string): Promise<AttestLimits> {
  const { data, error } = await supabase
    .from('company_attest_limits')
    .select('user_id, max_amount_sek')
    .eq('company_id', companyId)
    .eq('scope', 'supplier_invoice' satisfies AttestLimitScope)
  if (error) throw error
  return new Map(
    ((data ?? []) as Array<{ user_id: string; max_amount_sek: number | string | null }>).map((row) => [row.user_id, toAmount(row.max_amount_sek)]),
  )
}

/**
 * The invoices among `invoiceIds` that payment must leave out: the policy
 * requires attest for them and it has not been given (code attest_required
 * in the payment file and bank payment paths). Empty when the policy is off
 * or the company keeps kontantmetoden. Throws when it cannot tell: payment
 * must not read "no attest needed" from a failed read.
 */
export async function loadAttestBlockedInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const policy = await loadAttestPolicy(supabase, companyId)
  if (!policy.enabled) return new Set()
  const { data: settings, error: settingsError } = await supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle()
  if (settingsError) throw settingsError
  const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method ?? null
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select('id, user_id, approved_at, is_credit_note, currency, total, total_sek, exchange_rate')
    .eq('company_id', companyId)
    .in('id', [...invoiceIds])
  if (error) throw error
  const blocked = new Set<string>()
  for (const row of (data ?? []) as Array<AttestInvoiceFacts & { id: string; approved_at: string | null }>) {
    if (paymentWaitsForAttest(policy, accountingMethod, { ...row, total: Number(row.total) })) blocked.add(row.id)
  }
  return blocked
}

/**
 * True when the company has an attest step for supplier invoices at all
 * (companyAttestsSupplierInvoices: faktureringsmetoden with the attest policy
 * on). The payment paths ask it before they warn that an invoice is not
 * attested: where nobody is asked to attest, the warning sat on every line
 * and told the person nothing (crm#1141). A failed read answers true, the
 * warning as it always was: a warning never blocks a payment, so showing one
 * too many is the safe side.
 */
export async function loadCompanyAttestsSupplierInvoices(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const [{ data, error }, policyOn] = await Promise.all([
    supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
    loadAttestPolicyOn(supabase, companyId).catch(() => null), // a failed read answers true below: the warning never blocks
  ])
  if (error || policyOn === null) return true
  return companyAttestsSupplierInvoices((data as { accounting_method?: string | null } | null)?.accounting_method ?? null, policyOn)
}

/** The columns of a decision the rules read; ATTESTATION_STEP_COLUMNS adds the step and the substitute (migration 20261108180000). */
const ATTESTATION_BASE_COLUMNS = 'id, supplier_invoice_id, user_id, decision, comment, source, decided_at, step'
const ATTESTATION_STEP_COLUMNS = `${ATTESTATION_BASE_COLUMNS}, stage, on_behalf_of`

/**
 * Read decisions with the step and the substitute, or without them until the
 * migration that adds them has run: then no row has either.
 */
export async function withAttestationStepColumns<T>(read: (columns: string) => Promise<T>): Promise<T> {
  try {
    return await read(ATTESTATION_STEP_COLUMNS)
  } catch (error) {
    if (!isMissingColumnError(error as { code?: string })) throw error
    return read(ATTESTATION_BASE_COLUMNS)
  }
}

/**
 * Every decision on the invoices, by invoice id, oldest first. Paged
 * (fetchAllRows: PostgREST caps one read at 1000 rows) and ordered by
 * decided_at, so a long trail never loses its latest rejection. Throws on a
 * failed read.
 */
export async function loadAttestTrails(
  supabase: SupabaseClient,
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, AttestationRecord[]>> {
  const trails = new Map<string, AttestationRecord[]>()
  for (const part of chunk([...new Set(invoiceIds)], 150)) {
    type TrailRow = AttestationRecord & { supplier_invoice_id: string }
    // The columns are chosen at run time (withAttestationStepColumns), so the row type is stated, not inferred.
    const read = (columns: string) =>
      fetchAllRows<TrailRow>(
        ({ from, to }) =>
          supabase
            .from('supplier_invoice_attestations')
            .select(columns)
            .eq('company_id', companyId)
            .in('supplier_invoice_id', part)
            .order('decided_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{ data: TrailRow[] | null; error: { message: string } | null }>,
      )
    const rows = await withAttestationStepColumns(read)
    for (const row of rows) {
      const trail = trails.get(row.supplier_invoice_id) ?? []
      trail.push(row)
      trails.set(row.supplier_invoice_id, trail)
    }
  }
  return trails
}
