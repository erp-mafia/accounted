/**
 * The owner loan register (ABL 21 kap.): loans between the company and its
 * owners, board, VD and related persons, security the company gave for
 * them, and the interest per year. Nothing here books: the loan itself is
 * booked as any other verifikat, and the register is reconciled against
 * the ledger (reconcile.ts). The låneförbud check (loan-ban.ts) answers
 * warnings on every write and never refuses.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { bolagetFailure } from '../errors'
import { assertPartiesInCompany, checkPartyRef, ensureRegisterParty, loadRegisterParties, type PartyRef } from '../people'
import { famansDerivationFor, loadKu31Settings } from '../capital/ku31'
import { insiderFacts, loadInsiderTimeline } from './insiders'
import { assessLoanBan, type LoanBanAssessment } from './loan-ban'
import {
  accountFitsDirection,
  DEFAULT_LOAN_ACCOUNTS,
  RELATIONS_WITH_INSIDER,
  type LoanDirection,
  type LoanException,
  type LoanKind,
  type LoanRelation,
  type LoanStatus,
} from './types'

export interface OwnerLoanRow {
  id: string
  party_id: string
  kind: LoanKind
  direction: LoanDirection
  relation: LoanRelation
  related_to_party_id: string | null
  relation_detail: string | null
  account: string | null
  principal: number
  outstanding: number
  interest_rate: number | null
  start_date: string
  maturity_date: string | null
  terms: string | null
  document_id: string | null
  exception: LoanException
  exception_note: string | null
  status: LoanStatus
  repaid_on: string | null
  note: string | null
  created_at: string
}

export interface LoanInterestRow {
  owner_loan_id: string
  income_year: number
  interest_amount: number
  tax_withheld: number
  note: string | null
}

function normaliseLoan(row: Record<string, unknown>): OwnerLoanRow {
  return {
    ...(row as unknown as OwnerLoanRow),
    principal: Number(row.principal),
    outstanding: Number(row.outstanding),
    interest_rate: row.interest_rate === null || row.interest_rate === undefined ? null : Number(row.interest_rate),
  }
}

export async function loadOwnerLoans(supabase: SupabaseClient, companyId: string): Promise<OwnerLoanRow[]> {
  const { data, error } = await supabase
    .from('owner_loans')
    .select('id, party_id, kind, direction, relation, related_to_party_id, relation_detail, account, principal, outstanding, interest_rate, start_date, maturity_date, terms, document_id, exception, exception_note, status, repaid_on, note, created_at')
    .eq('company_id', companyId)
    .order('start_date', { ascending: false })
  if (error) throw new Error(`owner_loans read failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normaliseLoan)
}

export async function loadOwnerLoan(supabase: SupabaseClient, companyId: string, id: string): Promise<OwnerLoanRow | null> {
  const { data, error } = await supabase
    .from('owner_loans')
    .select('id, party_id, kind, direction, relation, related_to_party_id, relation_detail, account, principal, outstanding, interest_rate, start_date, maturity_date, terms, document_id, exception, exception_note, status, repaid_on, note, created_at')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`owner_loans read failed: ${error.message}`)
  return data ? normaliseLoan(data as Record<string, unknown>) : null
}

export async function loadLoanInterest(supabase: SupabaseClient, companyId: string, year: number | null = null): Promise<LoanInterestRow[]> {
  let query = supabase
    .from('owner_loan_interest')
    .select('owner_loan_id, income_year, interest_amount, tax_withheld, note')
    .eq('company_id', companyId)
  if (year !== null) query = query.eq('income_year', year)
  const { data, error } = await query.order('income_year', { ascending: false })
  if (error) throw new Error(`owner_loan_interest read failed: ${error.message}`)
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as LoanInterestRow),
    income_year: Number(r.income_year),
    interest_amount: Number(r.interest_amount),
    tax_withheld: Number(r.tax_withheld),
  }))
}

/** Whether a loan was owed at any time on or after `from` and on or before `to`. */
export function loanActiveBetween(loan: Pick<OwnerLoanRow, 'status' | 'start_date' | 'repaid_on'>, from: string, to: string): boolean {
  if (loan.status === 'cancelled') return false
  if (loan.start_date > to) return false
  return loan.repaid_on === null || loan.repaid_on >= from
}

/** Whether a loan is owed on a day (repaid on that day counts as repaid). */
export function loanActiveOn(loan: Pick<OwnerLoanRow, 'status' | 'start_date' | 'repaid_on'>, day: string): boolean {
  if (loan.status === 'cancelled') return false
  if (loan.start_date > day) return false
  return loan.repaid_on === null || loan.repaid_on > day
}

/** The låneförbud assessment of a loan, the registers read on its start date and today. */
export async function assessLoans(
  ctx: OperationContext,
  loans: ReadonlyArray<Pick<OwnerLoanRow, 'party_id' | 'kind' | 'direction' | 'relation' | 'exception' | 'start_date'> & { party_kind: 'person' | 'company' }>,
): Promise<LoanBanAssessment[]> {
  if (loans.length === 0) return []
  const timeline = await loadInsiderTimeline(ctx)
  const today = todayIsoStockholm()
  return loans.map((l) => {
    const facts = insiderFacts(timeline, l.party_id, l.start_date > today ? [l.start_date] : [l.start_date, today])
    return assessLoanBan({ direction: l.direction, kind: l.kind, relation: l.relation, exception: l.exception, party_kind: l.party_kind, ...facts })
  })
}

/** The fåmansföretag answer of a year: the one confirmed for KU31, else what the aktiebok suggests. */
export async function famansForYear(ctx: OperationContext, year: number): Promise<{ famansforetag: boolean; confirmed: boolean }> {
  const settings = await loadKu31Settings(ctx, year)
  if (settings?.famansforetag !== null && settings?.famansforetag !== undefined) return { famansforetag: settings.famansforetag, confirmed: true }
  const derived = await famansDerivationFor(ctx, year)
  return { famansforetag: derived.derived, confirmed: false }
}

function warning(code: string, sv: string, en: string): OperationWarning {
  return { code, message_sv: sv, message_en: en }
}

// ── Create ───────────────────────────────────────────────────────────

export interface OwnerLoanInput {
  party: PartyRef
  kind?: LoanKind | null
  direction: LoanDirection
  relation?: LoanRelation | null
  related_to_party_id?: string | null
  relation_detail?: string | null
  account?: string | null
  principal: number
  outstanding?: number | null
  interest_rate?: number | null
  start_date: string
  maturity_date?: string | null
  terms?: string | null
  document_id?: string | null
  exception?: LoanException | null
  exception_note?: string | null
  note?: string | null
}

export interface OwnerLoanCreated {
  owner_loan_id: string
  party_id: string
  kind: LoanKind
  direction: LoanDirection
  account: string | null
  principal: number
  outstanding: number
  loan_ban: { status: LoanBanAssessment['status']; exception: LoanBanAssessment['exception']; special_list: boolean }
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

/** The rules every write applies to the loan's shape; null when they hold. */
function checkShape(loan: {
  kind: LoanKind
  direction: LoanDirection
  relation: LoanRelation
  related_to_party_id: string | null
  party_id: string | null
  account: string | null
  principal: number
  outstanding: number
  start_date: string
  maturity_date: string | null
  repaid_on: string | null
}): Failure | null {
  if (loan.kind === 'security' && loan.direction !== 'lends') {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'En säkerhet är något bolaget ställer: välj riktningen bolaget lånar ut.' }
  }
  if (loan.kind === 'loan' && !loan.account) return { ok: false, code: 'OWNER_LOAN_ACCOUNT_INVALID' }
  if (loan.account && !accountFitsDirection(loan.account, loan.direction)) return { ok: false, code: 'OWNER_LOAN_ACCOUNT_INVALID' }
  if (RELATIONS_WITH_INSIDER.includes(loan.relation) !== Boolean(loan.related_to_party_id)) return { ok: false, code: 'OWNER_LOAN_RELATED_REQUIRED' }
  if (loan.related_to_party_id && loan.related_to_party_id === loan.party_id) return { ok: false, code: 'OWNER_LOAN_RELATED_REQUIRED' }
  if (!(loan.principal > 0) || loan.outstanding < 0 || loan.outstanding > loan.principal) return { ok: false, code: 'OWNER_LOAN_OUTSTANDING_INVALID' }
  if (loan.maturity_date && loan.maturity_date < loan.start_date) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Förfallodagen kan inte ligga före startdagen.' }
  if (loan.repaid_on && loan.repaid_on < loan.start_date) return { ok: false, code: 'BOLAGET_DATES_INVALID', messageSv: 'Återbetalningsdagen kan inte ligga före startdagen.' }
  return null
}

/**
 * The party a reference names, without creating it: an existing party id,
 * a register person with exactly that name, or a company with that org
 * number (the same lookups ensureRegisterParty makes before it creates).
 * The dry run and the commit assess the same party this way.
 */
async function resolvePartyRef(ctx: OperationContext, ref: PartyRef): Promise<{ party_id: string | null; name: string | null; kind: 'person' | 'company' }> {
  if (ref.party_id) {
    const p = (await loadRegisterParties(ctx.companyId, [ref.party_id])).get(ref.party_id)
    return { party_id: ref.party_id, name: p?.name ?? null, kind: p?.kind ?? 'person' }
  }
  const name = ref.name?.trim() ?? null
  const kind: 'person' | 'company' = ref.kind === 'company' || ref.org_number ? 'company' : 'person'
  let query = ctx.supabase.from('parties').select('id').eq('company_id', ctx.companyId).is('merged_into', null)
  if (kind === 'company' && ref.org_number) query = query.eq('org_number', normalizeOrgNumber(ref.org_number))
  else if (name) query = query.eq('kind', 'person').ilike('display_name', name.replace(/[%_\\]/g, (c) => `\\${c}`))
  else return { party_id: null, name, kind }
  const { data, error } = await query.limit(2)
  if (error) throw new Error(`parties read failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string }>
  return { party_id: rows.length === 1 ? rows[0]!.id : null, name, kind }
}

export async function createOwnerLoan(ctx: OperationContext, input: OwnerLoanInput, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<OwnerLoanCreated>> {
  try {
    const kind: LoanKind = input.kind ?? 'loan'
    const relation: LoanRelation = input.relation ?? 'none'
    const principal = roundOre(input.principal)
    const outstanding = roundOre(input.outstanding ?? principal)
    const account = kind === 'security' ? input.account ?? null : input.account ?? DEFAULT_LOAN_ACCOUNTS[input.direction].short
    checkPartyRef(input.party, 'motparten')
    const shapeFailure = checkShape({
      kind,
      direction: input.direction,
      relation,
      related_to_party_id: input.related_to_party_id ?? null,
      party_id: input.party.party_id ?? null,
      account,
      principal,
      outstanding,
      start_date: input.start_date,
      maturity_date: input.maturity_date ?? null,
      repaid_on: null,
    })
    if (shapeFailure) return shapeFailure
    await assertPartiesInCompany(ctx.supabase, ctx.companyId, [input.party.party_id, input.related_to_party_id])

    const party = await resolvePartyRef(ctx, input.party)
    const exception: LoanException = input.exception ?? 'none'
    const [assessment] = await assessLoans(ctx, [
      { party_id: party.party_id ?? '', party_kind: party.kind, kind, direction: input.direction, relation, exception, start_date: input.start_date },
    ])
    const warnings: OperationWarning[] = [...assessment!.warnings]
    if (input.direction === 'lends' && !party.party_id && relation === 'none') {
      warnings.push(warning(
        'OWNER_LOAN_PARTY_UNKNOWN',
        'Motparten finns inte i aktieboken eller bland rollerna. Ange om personen är närstående till en aktieägare, styrelseledamot eller VD.',
        'The counterparty is not in the share register or the roles. State whether the person is related to a shareholder, board member or VD.',
      ))
    }
    const loanBan = { status: assessment!.status, exception: assessment!.exception, special_list: assessment!.special_list }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          party: { party_id: party.party_id, name: party.name, kind: party.kind },
          kind,
          direction: input.direction,
          account,
          principal,
          outstanding,
          interest_rate: input.interest_rate ?? null,
          start_date: input.start_date,
          loan_ban: loanBan,
          warnings: warnings.map((w) => w.message_sv),
        },
      }
    }

    const partyId = party.party_id ?? (await ensureRegisterParty(ctx, input.party))
    const { data, error } = await ctx.supabase
      .from('owner_loans')
      .insert({
        company_id: ctx.companyId,
        party_id: partyId,
        kind,
        direction: input.direction,
        relation,
        related_to_party_id: input.related_to_party_id ?? null,
        relation_detail: input.relation_detail?.trim() || null,
        account,
        principal,
        outstanding,
        interest_rate: input.interest_rate ?? null,
        start_date: input.start_date,
        maturity_date: input.maturity_date ?? null,
        terms: input.terms?.trim() || null,
        document_id: input.document_id ?? null,
        exception,
        exception_note: input.exception_note?.trim() || null,
        status: 'active',
        note: input.note?.trim() || null,
        created_by: ctx.userId,
      })
      .select('id')
      .single()
    if (error) throw new Error(`owner_loans insert failed: ${error.message}`)
    return {
      ok: true,
      data: { owner_loan_id: (data as { id: string }).id, party_id: partyId, kind, direction: input.direction, account, principal, outstanding, loan_ban: loanBan },
      created: true,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return ownerTaxFailure(error)
  }
}

// ── Update ───────────────────────────────────────────────────────────

export interface OwnerLoanPatch {
  owner_loan_id: string
  relation?: LoanRelation | null
  related_to_party_id?: string | null
  relation_detail?: string | null
  account?: string | null
  principal?: number | null
  outstanding?: number | null
  interest_rate?: number | null
  maturity_date?: string | null
  terms?: string | null
  document_id?: string | null
  exception?: LoanException | null
  exception_note?: string | null
  status?: LoanStatus | null
  repaid_on?: string | null
  note?: string | null
}

export interface OwnerLoanUpdated {
  owner_loan_id: string
  status: LoanStatus
  outstanding: number
  loan_ban: { status: LoanBanAssessment['status']; exception: LoanBanAssessment['exception']; special_list: boolean }
}

/** A key the patch sets (null clears a nullable field); undefined leaves it. */
function has<K extends keyof OwnerLoanPatch>(patch: OwnerLoanPatch, key: K): boolean {
  return patch[key] !== undefined
}

export async function updateOwnerLoan(ctx: OperationContext, patch: OwnerLoanPatch, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<OwnerLoanUpdated>> {
  try {
    const loan = await loadOwnerLoan(ctx.supabase, ctx.companyId, patch.owner_loan_id)
    if (!loan) return { ok: false, code: 'OWNER_LOAN_NOT_FOUND' }
    if (loan.status === 'cancelled') return { ok: false, code: 'OWNER_LOAN_STATUS_INVALID' }

    const status: LoanStatus = patch.status ?? loan.status
    if (status === 'repaid' && !(patch.repaid_on ?? loan.repaid_on)) {
      return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ange dagen då lånet återbetalades.' }
    }
    const relation = patch.relation ?? loan.relation
    const next = {
      relation,
      related_to_party_id: has(patch, 'related_to_party_id') ? patch.related_to_party_id ?? null : RELATIONS_WITH_INSIDER.includes(relation) ? loan.related_to_party_id : null,
      relation_detail: has(patch, 'relation_detail') ? patch.relation_detail?.trim() || null : loan.relation_detail,
      account: has(patch, 'account') ? patch.account ?? null : loan.account,
      principal: patch.principal !== undefined && patch.principal !== null ? roundOre(patch.principal) : loan.principal,
      outstanding: status === 'repaid' ? 0 : patch.outstanding !== undefined && patch.outstanding !== null ? roundOre(patch.outstanding) : loan.outstanding,
      interest_rate: has(patch, 'interest_rate') ? patch.interest_rate ?? null : loan.interest_rate,
      maturity_date: has(patch, 'maturity_date') ? patch.maturity_date ?? null : loan.maturity_date,
      terms: has(patch, 'terms') ? patch.terms?.trim() || null : loan.terms,
      document_id: has(patch, 'document_id') ? patch.document_id ?? null : loan.document_id,
      exception: patch.exception ?? loan.exception,
      exception_note: has(patch, 'exception_note') ? patch.exception_note?.trim() || null : loan.exception_note,
      status,
      repaid_on: status === 'repaid' ? patch.repaid_on ?? loan.repaid_on : null,
      note: has(patch, 'note') ? patch.note?.trim() || null : loan.note,
    }
    const shapeFailure = checkShape({ ...next, kind: loan.kind, direction: loan.direction, party_id: loan.party_id, start_date: loan.start_date })
    if (shapeFailure) return shapeFailure
    if (next.related_to_party_id) await assertPartiesInCompany(ctx.supabase, ctx.companyId, [next.related_to_party_id])

    const party = (await loadRegisterParties(ctx.companyId, [loan.party_id])).get(loan.party_id)
    const [assessment] = await assessLoans(ctx, [
      { party_id: loan.party_id, party_kind: party?.kind ?? 'person', kind: loan.kind, direction: loan.direction, relation: next.relation, exception: next.exception, start_date: loan.start_date },
    ])
    const loanBan = { status: assessment!.status, exception: assessment!.exception, special_list: assessment!.special_list }
    const warnings = status === 'active' ? [...assessment!.warnings] : []
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          owner_loan_id: loan.id,
          party: { party_id: loan.party_id, name: party?.name ?? null },
          before: { status: loan.status, outstanding: loan.outstanding, exception: loan.exception, account: loan.account },
          after: { status: next.status, outstanding: next.outstanding, exception: next.exception, account: next.account, repaid_on: next.repaid_on },
          loan_ban: loanBan,
          warnings: warnings.map((w) => w.message_sv),
        },
      }
    }
    const { error } = await ctx.supabase
      .from('owner_loans')
      .update({
        relation: next.relation,
        related_to_party_id: next.related_to_party_id,
        relation_detail: next.relation_detail,
        account: next.account,
        principal: next.principal,
        outstanding: next.outstanding,
        interest_rate: next.interest_rate,
        maturity_date: next.maturity_date,
        terms: next.terms,
        document_id: next.document_id,
        exception: next.exception,
        exception_note: next.exception_note,
        status: next.status,
        repaid_on: next.repaid_on,
        note: next.note,
      })
      .eq('company_id', ctx.companyId)
      .eq('id', loan.id)
    if (error) throw new Error(`owner_loans update failed: ${error.message}`)
    return {
      ok: true,
      data: { owner_loan_id: loan.id, status: next.status, outstanding: next.outstanding, loan_ban: loanBan },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return ownerTaxFailure(error)
  }
}

// ── Interest per year ────────────────────────────────────────────────

export interface LoanInterestInput {
  owner_loan_id: string
  income_year: number
  interest_amount: number
  tax_withheld?: number | null
  note?: string | null
}

export interface LoanInterestSaved {
  owner_loan_id: string
  income_year: number
  interest_amount: number
  tax_withheld: number
}

/** Preliminary tax a fåmansföretag withholds on interest to a delägare (SFL 10:15). */
export const OWNER_INTEREST_WITHHOLDING = 0.3

export async function setLoanInterest(ctx: OperationContext, input: LoanInterestInput, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<LoanInterestSaved>> {
  try {
    const loan = await loadOwnerLoan(ctx.supabase, ctx.companyId, input.owner_loan_id)
    if (!loan || loan.kind !== 'loan') return { ok: false, code: 'OWNER_LOAN_NOT_FOUND' }
    if (loan.status === 'cancelled') return { ok: false, code: 'OWNER_LOAN_STATUS_INVALID' }
    const interest = roundOre(input.interest_amount)
    const tax = roundOre(input.tax_withheld ?? 0)
    if (interest < 0 || tax < 0 || tax > interest) return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Den avdragna skatten kan inte vara större än räntan.' }

    const warnings: OperationWarning[] = []
    if (loan.direction === 'borrows' && interest > 0) {
      const party = (await loadRegisterParties(ctx.companyId, [loan.party_id])).get(loan.party_id)
      const famans = await famansForYear(ctx, input.income_year)
      const expected = roundOre(interest * OWNER_INTEREST_WITHHOLDING)
      if (party?.kind === 'person' && famans.famansforetag && tax !== expected) {
        warnings.push(warning(
          'KU20_WITHHOLDING_EXPECTED',
          `Ett fåmansföretag gör skatteavdrag med 30 % på ränta till en delägare (${expected} kr på ${interest} kr). Kontrollera den avdragna skatten.`,
          `A close company withholds 30 % tax on interest to a shareholder (${expected} kr on ${interest} kr). Check the tax withheld.`,
        ))
      }
    }
    if (dryRun) {
      return { ok: true, dryRun: true, preview: { owner_loan_id: loan.id, income_year: input.income_year, interest_amount: interest, tax_withheld: tax, warnings: warnings.map((w) => w.message_sv) } }
    }
    const { error } = await ctx.supabase
      .from('owner_loan_interest')
      .upsert(
        {
          company_id: ctx.companyId,
          owner_loan_id: loan.id,
          income_year: input.income_year,
          interest_amount: interest,
          tax_withheld: tax,
          note: input.note?.trim() || null,
          updated_by: ctx.userId,
        },
        { onConflict: 'owner_loan_id,income_year' },
      )
    if (error) throw new Error(`owner_loan_interest upsert failed: ${error.message}`)
    return {
      ok: true,
      data: { owner_loan_id: loan.id, income_year: input.income_year, interest_amount: interest, tax_withheld: tax },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return ownerTaxFailure(error)
  }
}

/** Codes the owner tax tables raise as `CODE: text` (20261030040000_bolaget_owner_tax.sql). */
const DB_CODES = ['OWNER_LOAN_APPEND_ONLY'] as const

export function ownerTaxFailure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : ''
  const code = DB_CODES.find((c) => message.includes(c))
  if (code) return { ok: false, code }
  return bolagetFailure(error)
}
