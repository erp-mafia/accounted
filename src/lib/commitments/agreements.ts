import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
import { addDays, todayIso } from '@/lib/arkiv/agreements/dates'
import { syncAgreementDeadlines, syncObligations } from '@/lib/arkiv/agreements/store'
import type { OperationOutcome } from '@/lib/operations/types'
import { manualAgreementSchedule, manualDeadlineNote, type ManualAgreementTerms } from './schedule'
import type { CreateAgreementInput, EndAgreementInput, UpdateAgreementInput } from './schemas'
import type { AgreementPeriod, AgreementStatus, AgreementView, ManualAgreementKind, ObligationView } from './types'

/**
 * Agreements for every company in the Bolaget rollout: registered by hand
 * (origin 'manual'), shown beside the ones the Arkiv pipeline derives from
 * documents. A manual agreement's expected payments and its dates in
 * Viktiga datum are written with it and refreshed daily
 * (app/api/arkiv/derive/cron), and observed against the bank like the
 * derived ones. Derived agreements are the pipeline's: read here, never
 * written. Every door (session routes, v1, MCP) calls these functions.
 */
export interface CommitmentsContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
}

const UNAVAILABLE = { ok: false as const, code: 'COMMITMENTS_UNAVAILABLE' }

/**
 * An agreements row as read: the view's columns under their table names,
 * NUMERIC as PostgREST sends it. Each select writes the columns out so the
 * schema guard (tests/schema/no-phantom-columns.test.ts) checks them.
 */
export type AgreementRow = Omit<
  AgreementView,
  'agreement_id' | 'amount' | 'principal' | 'interest_rate' | 'next_payment' | 'notice_deadline' | 'end_deadline'
> & {
  id: string
  company_id: string
  amount: number | string | null
  principal: number | string | null
  interest_rate: number | string | null
}

interface ObligationRow {
  id: string
  agreement_id: string
  kind: string
  due_on: string
  amount: number | string
  currency: string
  direction: 'out' | 'in'
  status: 'expected' | 'matched' | 'missed' | 'waived'
  amount_is_estimate: boolean
  transaction_id: string | null
}

interface DeadlineRow {
  source_key: string
  due_date: string
  title: string
}

const num = (v: number | string | null): number | null => (v == null ? null : Number(v))

function termsOf(row: AgreementRow): ManualAgreementTerms {
  return {
    kind: row.kind as ManualAgreementKind,
    title: row.title,
    status: row.status,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    first_due_on: row.first_due_on,
    notice_months: row.notice_months,
    renewal_terms: row.renewal_terms,
    amount: num(row.amount),
    currency: row.currency,
    period: row.period,
  }
}

export function agreementView(row: AgreementRow, obligations: ObligationRow[], deadlines: Map<string, DeadlineRow>, today: string): AgreementView {
  const own = obligations.filter((o) => o.agreement_id === row.id && o.status !== 'waived').sort((a, b) => a.due_on.localeCompare(b.due_on))
  const next =
    own.find((o) => o.due_on >= today && o.status === 'expected') ??
    [...own].reverse().find((o) => o.status === 'missed') ??
    own.find((o) => o.due_on >= today) ??
    null
  const deadline = (key: string) => {
    const d = deadlines.get(`agreement:${row.id}:${key}`)
    return d ? { due_date: d.due_date, title: d.title } : null
  }
  return {
    agreement_id: row.id,
    kind: row.kind,
    origin: row.origin,
    title: row.title,
    status: row.status,
    counterparty_party_id: row.counterparty_party_id,
    counterparty_name: row.counterparty_name,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    notice_months: row.notice_months,
    renewal_terms: row.renewal_terms,
    amount: num(row.amount),
    currency: row.currency,
    period: row.period,
    first_due_on: row.first_due_on,
    principal: num(row.principal),
    interest_rate: num(row.interest_rate),
    document_id: row.document_id,
    source_document_id: row.source_document_id,
    notes: row.notes,
    next_payment: next
      ? { due_on: next.due_on, amount: Number(next.amount), currency: next.currency, status: next.status, direction: next.direction }
      : null,
    notice_deadline: deadline('notice'),
    end_deadline: deadline('end') ?? deadline('maturity'),
  }
}

async function loadObligations(supabase: SupabaseClient, companyId: string, since: string, agreementId?: string): Promise<ObligationRow[]> {
  return fetchAllRows<ObligationRow>((range) => {
    let query = supabase
      .from('agreement_obligations')
      .select('id, agreement_id, kind, due_on, amount, currency, direction, status, amount_is_estimate, transaction_id')
      .eq('company_id', companyId)
      .gte('due_on', since)
    if (agreementId) query = query.eq('agreement_id', agreementId)
    return query.order('due_on', { ascending: true }).order('id', { ascending: true }).range(range.from, range.to)
  })
}

async function loadAgreementDeadlines(supabase: SupabaseClient, companyId: string): Promise<Map<string, DeadlineRow>> {
  const rows = await fetchAllRows<DeadlineRow>((range) =>
    supabase
      .from('deadlines')
      .select('source_key, due_date, title')
      .eq('company_id', companyId)
      .like('source_key', 'agreement:%')
      .eq('is_completed', false)
      .is('dismissed_at', null)
      .order('source_key', { ascending: true })
      .range(range.from, range.to),
  )
  return new Map(rows.map((d) => [d.source_key, d]))
}

export interface ListAgreementsFilter {
  status?: AgreementStatus
  kind?: ManualAgreementKind
  origin?: 'derived' | 'manual'
}

export async function listAgreements(
  ctx: CommitmentsContext,
  filter: ListAgreementsFilter = {},
  today: string = todayIso(),
): Promise<OperationOutcome<{ agreements: AgreementView[] }>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const rows = await fetchAllRows<AgreementRow>((range) => {
    let query = ctx.supabase.from('agreements').select('id, company_id, kind, origin, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, first_due_on, principal, interest_rate, document_id, source_document_id, notes').eq('company_id', ctx.companyId)
    if (filter.status) query = query.eq('status', filter.status)
    if (filter.kind) query = query.eq('kind', filter.kind)
    if (filter.origin) query = query.eq('origin', filter.origin)
    return query.order('status', { ascending: true }).order('title', { ascending: true }).order('id', { ascending: true }).range(range.from, range.to)
  })
  if (rows.length === 0) return { ok: true, data: { agreements: [] } }
  const [obligations, deadlines] = await Promise.all([
    loadObligations(ctx.supabase, ctx.companyId, addDays(today, -60)),
    loadAgreementDeadlines(ctx.supabase, ctx.companyId),
  ])
  return { ok: true, data: { agreements: rows.map((r) => agreementView(r, obligations, deadlines, today)) } }
}

export interface ListObligationsFilter {
  agreement_id?: string
  status?: ObligationView['status']
  from?: string
  to?: string
}

/** Expected payments, oldest first; by default from 60 days back. */
export async function listObligations(
  ctx: CommitmentsContext,
  filter: ListObligationsFilter = {},
  today: string = todayIso(),
): Promise<OperationOutcome<{ obligations: ObligationView[] }>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  if (filter.agreement_id && !(await findAgreement(ctx, filter.agreement_id))) return { ok: false, code: 'AGREEMENT_NOT_FOUND' }
  const rows = await loadObligations(ctx.supabase, ctx.companyId, filter.from ?? addDays(today, -60), filter.agreement_id)
  const picked = rows.filter((o) => (!filter.status || o.status === filter.status) && (!filter.to || o.due_on <= filter.to))
  const ids = [...new Set(picked.map((o) => o.agreement_id))]
  const titles = new Map<string, string>()
  if (ids.length > 0) {
    const { data, error } = await ctx.supabase.from('agreements').select('id, title').eq('company_id', ctx.companyId).in('id', ids)
    if (error) throw error
    for (const a of (data ?? []) as Array<{ id: string; title: string }>) titles.set(a.id, a.title)
  }
  return {
    ok: true,
    data: {
      obligations: picked.map((o) => ({
        obligation_id: o.id,
        agreement_id: o.agreement_id,
        agreement_title: titles.get(o.agreement_id) ?? '',
        kind: o.kind,
        due_on: o.due_on,
        amount: Number(o.amount),
        currency: o.currency,
        direction: o.direction,
        status: o.status,
        amount_is_estimate: o.amount_is_estimate,
        transaction_id: o.transaction_id,
      })),
    },
  }
}

async function findAgreement(ctx: CommitmentsContext, id: string): Promise<AgreementRow | null> {
  const { data, error } = await ctx.supabase.from('agreements').select('id, company_id, kind, origin, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, first_due_on, principal, interest_rate, document_id, source_document_id, notes').eq('company_id', ctx.companyId).eq('id', id).maybeSingle()
  if (error) throw error
  return (data as AgreementRow | null) ?? null
}

/**
 * The ids a write names belong to the company: a party, an archived
 * document, an agreement. Answers the failure for the first that does not.
 */
export async function checkReferences(
  ctx: CommitmentsContext,
  refs: { party_id?: { field: string; id: string | null | undefined }; document_id?: string | null; agreement_id?: string | null },
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  const missing = (field: string) => ({ ok: false as const, code: 'COMMITMENTS_REFERENCE_NOT_FOUND', details: { field } })
  if (refs.party_id?.id) {
    const { data, error } = await ctx.supabase.from('parties').select('id').eq('company_id', ctx.companyId).eq('id', refs.party_id.id).maybeSingle()
    if (error) throw error
    if (!data) return missing(refs.party_id.field)
  }
  if (refs.document_id) {
    const { data, error } = await ctx.supabase.from('document_attachments').select('id').eq('company_id', ctx.companyId).eq('id', refs.document_id).maybeSingle()
    if (error) throw error
    if (!data) return missing('document_id')
  }
  if (refs.agreement_id) {
    if (!(await findAgreement(ctx, refs.agreement_id))) return missing('agreement_id')
  }
  return null
}

/** Writes the expected payments and the dates a manual agreement implies today. */
export async function refreshManualAgreement(supabase: SupabaseClient, row: AgreementRow, today: string): Promise<{ obligations: number; deadlines: number }> {
  const schedule = manualAgreementSchedule(termsOf(row), today)
  const obligations = await syncObligations(supabase, row.company_id, row.id, schedule.obligations, today)
  const deadlines = await syncAgreementDeadlines(
    supabase,
    { companyId: row.company_id, documentId: null, noteFor: (draft) => manualDeadlineNote(row.title, draft) },
    row.id,
    schedule.deadlines,
    today,
  )
  return { obligations, deadlines }
}

/** Every manual agreement of a company, for the daily job; answers their ids for the observation. */
export async function refreshManualAgreements(supabase: SupabaseClient, companyId: string, today: string): Promise<{ agreementIds: string[]; refreshed: number }> {
  const rows = await fetchAllRows<AgreementRow>((range) =>
    supabase
      .from('agreements')
      .select('id, company_id, kind, origin, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, first_due_on, principal, interest_rate, document_id, source_document_id, notes')
      .eq('company_id', companyId)
      .eq('origin', 'manual')
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  let refreshed = 0
  for (const row of rows.filter((r) => r.status === 'active')) {
    await refreshManualAgreement(supabase, row, today)
    refreshed++
  }
  return { agreementIds: rows.map((r) => r.id), refreshed }
}

function scheduleSummary(terms: ManualAgreementTerms, today: string): Record<string, unknown> {
  const schedule = manualAgreementSchedule(terms, today)
  return {
    expected_payments: schedule.obligations.map((o) => ({ due_on: o.dueOn, amount: o.amount, currency: o.currency, direction: o.direction ?? 'out' })),
    dates: schedule.deadlines.map((d) => ({ key: d.key, due_on: d.dueOn, title: d.title })),
  }
}

interface AgreementColumns {
  kind?: string
  title?: string
  counterparty_name?: string | null
  counterparty_party_id?: string | null
  starts_on?: string | null
  ends_on?: string | null
  notice_months?: number | null
  renewal_terms?: string | null
  amount?: number | null
  currency?: string
  period?: AgreementPeriod | null
  first_due_on?: string | null
  principal?: number | null
  interest_rate?: number | null
  document_id?: string | null
  notes?: string | null
}

/** The columns an input sets; an absent field stays undefined (left alone), a blank text becomes null. */
function columnsFrom(input: Partial<CreateAgreementInput>): AgreementColumns {
  const text = (v: string | null | undefined) => (v === undefined ? undefined : v || null)
  const money = (v: number | null | undefined) => (v == null ? v : roundOre(v))
  return {
    kind: input.kind,
    title: input.title,
    counterparty_name: text(input.counterparty_name),
    counterparty_party_id: input.counterparty_party_id,
    starts_on: input.starts_on,
    ends_on: input.ends_on,
    notice_months: input.notice_months,
    renewal_terms: text(input.renewal_terms),
    amount: money(input.amount),
    currency: input.currency,
    period: input.period,
    first_due_on: input.first_due_on,
    principal: money(input.principal),
    interest_rate: input.interest_rate,
    document_id: input.document_id,
    notes: text(input.notes),
  }
}

/** Only the columns that are set: what a preview shows and what decides whether an update writes anything. */
function setColumns(columns: AgreementColumns): Record<string, unknown> {
  return Object.fromEntries(Object.entries(columns).filter(([, v]) => v !== undefined))
}

export async function createAgreement(
  ctx: CommitmentsContext,
  input: CreateAgreementInput,
  opts: { dryRun: boolean; today?: string },
): Promise<OperationOutcome<AgreementView>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const today = opts.today ?? todayIso()
  const refused = await checkReferences(ctx, {
    party_id: { field: 'counterparty_party_id', id: input.counterparty_party_id },
    document_id: input.document_id,
  })
  if (refused) return refused
  const columns = columnsFrom(input)
  const terms: ManualAgreementTerms = {
    kind: input.kind,
    title: input.title,
    status: 'active',
    starts_on: input.starts_on ?? null,
    ends_on: input.ends_on ?? null,
    first_due_on: input.first_due_on ?? null,
    notice_months: input.notice_months ?? null,
    renewal_terms: input.renewal_terms || null,
    amount: input.amount ?? null,
    currency: input.currency ?? 'SEK',
    period: input.period ?? null,
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, preview: { action: 'create', agreement: { ...setColumns(columns), origin: 'manual', status: 'active' }, ...scheduleSummary(terms, today) } }
  }
  const { data, error } = await ctx.supabase
    .from('agreements')
    .insert({
      company_id: ctx.companyId,
      origin: 'manual',
      status: 'active',
      created_by: ctx.userId,
      source_document_id: null,
      kind: columns.kind,
      title: columns.title,
      counterparty_name: columns.counterparty_name,
      counterparty_party_id: columns.counterparty_party_id,
      starts_on: columns.starts_on,
      ends_on: columns.ends_on,
      notice_months: columns.notice_months,
      renewal_terms: columns.renewal_terms,
      amount: columns.amount,
      currency: columns.currency,
      period: columns.period,
      first_due_on: columns.first_due_on,
      principal: columns.principal,
      interest_rate: columns.interest_rate,
      document_id: columns.document_id,
      notes: columns.notes,
    })
    .select('id, company_id, kind, origin, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, first_due_on, principal, interest_rate, document_id, source_document_id, notes')
    .single()
  if (error) throw error
  const row = data as AgreementRow
  await refreshManualAgreement(ctx.supabase, row, today)
  return { ok: true, created: true, data: await viewOf(ctx, row, today) }
}

async function viewOf(ctx: CommitmentsContext, row: AgreementRow, today: string): Promise<AgreementView> {
  const [obligations, deadlines] = await Promise.all([
    loadObligations(ctx.supabase, ctx.companyId, addDays(today, -60), row.id),
    loadAgreementDeadlines(ctx.supabase, ctx.companyId),
  ])
  return agreementView(row, obligations, deadlines, today)
}

async function manualAgreementOrFailure(
  ctx: CommitmentsContext,
  id: string,
): Promise<{ row: AgreementRow } | Extract<OperationOutcome<never>, { ok: false }>> {
  const row = await findAgreement(ctx, id)
  if (!row) return { ok: false, code: 'AGREEMENT_NOT_FOUND' }
  if (row.origin !== 'manual') return { ok: false, code: 'AGREEMENT_DERIVED', details: { source_document_id: row.source_document_id } }
  return { row }
}

export async function updateAgreement(
  ctx: CommitmentsContext,
  id: string,
  input: UpdateAgreementInput,
  opts: { dryRun: boolean; today?: string },
): Promise<OperationOutcome<AgreementView>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const today = opts.today ?? todayIso()
  const found = await manualAgreementOrFailure(ctx, id)
  if (!('row' in found)) return found
  const refused = await checkReferences(ctx, {
    party_id: { field: 'counterparty_party_id', id: input.counterparty_party_id },
    document_id: input.document_id,
  })
  if (refused) return refused
  const columns = columnsFrom(input)
  const changes = setColumns(columns)
  const merged = { ...found.row, ...changes } as AgreementRow
  if (merged.starts_on && merged.ends_on && merged.ends_on < merged.starts_on) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Slutdatumet ligger före startdatumet.', details: { field: 'ends_on' } }
  }
  if (num(merged.amount) && !merged.period) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange hur ofta beloppet ska betalas.', details: { field: 'period' } }
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, preview: { action: 'update', agreement_id: id, changes, ...scheduleSummary(termsOf(merged), today) } }
  }
  if (Object.keys(changes).length === 0) return { ok: true, data: await viewOf(ctx, found.row, today) }
  const { data, error } = await ctx.supabase
    .from('agreements')
    .update({
      kind: columns.kind,
      title: columns.title,
      counterparty_name: columns.counterparty_name,
      counterparty_party_id: columns.counterparty_party_id,
      starts_on: columns.starts_on,
      ends_on: columns.ends_on,
      notice_months: columns.notice_months,
      renewal_terms: columns.renewal_terms,
      amount: columns.amount,
      currency: columns.currency,
      period: columns.period,
      first_due_on: columns.first_due_on,
      principal: columns.principal,
      interest_rate: columns.interest_rate,
      document_id: columns.document_id,
      notes: columns.notes,
    })
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .eq('origin', 'manual')
    .select('id, company_id, kind, origin, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, first_due_on, principal, interest_rate, document_id, source_document_id, notes')
    .single()
  if (error) throw error
  const row = data as AgreementRow
  await refreshManualAgreement(ctx.supabase, row, today)
  return { ok: true, data: await viewOf(ctx, row, today) }
}

/**
 * Ends an agreement: status ended, ends_on the day it ended (an earlier
 * ends_on stays), its expected payments after that day and its dates in
 * Viktiga datum go. Ending twice answers the same.
 */
export async function endAgreement(
  ctx: CommitmentsContext,
  id: string,
  input: EndAgreementInput,
  opts: { dryRun: boolean; today?: string },
): Promise<OperationOutcome<AgreementView>> {
  if (!commitmentsEnabledFor(ctx.companyId)) return UNAVAILABLE
  const today = opts.today ?? todayIso()
  const found = await manualAgreementOrFailure(ctx, id)
  if (!('row' in found)) return found
  const endedOn = input.ended_on ?? today
  if (found.row.starts_on && endedOn < found.row.starts_on) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Avtalet kan inte avslutas före startdatumet.', details: { field: 'ended_on' } }
  }
  const endsOn = found.row.ends_on && found.row.ends_on < endedOn ? found.row.ends_on : endedOn
  if (opts.dryRun) {
    return { ok: true, dryRun: true, preview: { action: 'end', agreement_id: id, title: found.row.title, ends_on: endsOn } }
  }
  const { data, error } = await ctx.supabase
    .from('agreements')
    .update({ status: 'ended', ends_on: endsOn })
    .eq('company_id', ctx.companyId)
    .eq('id', id)
    .eq('origin', 'manual')
    .select('id, company_id, kind, origin, title, status, counterparty_party_id, counterparty_name, starts_on, ends_on, notice_months, renewal_terms, amount, currency, period, first_due_on, principal, interest_rate, document_id, source_document_id, notes')
    .single()
  if (error) throw error
  const row = data as AgreementRow
  await refreshManualAgreement(ctx.supabase, row, today)
  return { ok: true, data: await viewOf(ctx, row, today) }
}
