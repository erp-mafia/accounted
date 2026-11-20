/**
 * The owner loan register as the page and the read doors show it: every
 * loan with its counterparty (name and masked identity), the låneförbud
 * assessment, the interest per year, the reconciliation against the ledger
 * on a day, the 21:10 special list of a year, and the ÅRL 5:18 note.
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import type { OperationContext } from '@/lib/operations/types'
import { loadRegisterParties } from '../people'
import { buildBoardLoansNote, type BoardLoansNote, type BoardNoteLoan } from './arl-note'
import { loadInsiderTimeline } from './insiders'
import { loanAccountBalances } from './ledger'
import { LOAN_CIRCLE_LABELS_SV, type LoanBanAssessment } from './loan-ban'
import { assessLoans, loadLoanInterest, loadOwnerLoans, loanActiveBetween, loanActiveOn, type OwnerLoanRow } from './loans'
import { reconcileLoanAccounts, type LoanAccountReconciliation } from './reconcile'
import { LOAN_EXCEPTION_LABELS_SV, LOAN_RELATION_LABELS_SV } from './types'

export interface OwnerLoanView extends Omit<OwnerLoanRow, 'id' | 'party_id' | 'related_to_party_id' | 'created_at'> {
  owner_loan_id: string
  party: { party_id: string; name: string; kind: 'person' | 'company'; identity: string | null }
  related_to: { party_id: string; name: string } | null
  loan_ban: LoanBanAssessment
  interest: Array<{ income_year: number; interest_amount: number; tax_withheld: number }>
}

export interface OwnerLoansView {
  as_of: string
  loans: OwnerLoanView[]
  reconciliation: LoanAccountReconciliation[]
  /** Active loans the check flags (no exception clears them). */
  flagged: number
}

export async function loadOwnerLoansView(ctx: OperationContext, asOf: string | null = null): Promise<OwnerLoansView> {
  const day = asOf ?? todayIsoStockholm()
  const [loans, interest] = await Promise.all([loadOwnerLoans(ctx.supabase, ctx.companyId), loadLoanInterest(ctx.supabase, ctx.companyId)])
  const parties = await loadRegisterParties(ctx.companyId, loans.flatMap((l) => [l.party_id, l.related_to_party_id]).filter((id): id is string => Boolean(id)))
  const assessments = await assessLoans(
    ctx,
    loans.map((l) => ({ ...l, party_kind: parties.get(l.party_id)?.kind ?? 'person' })),
  )
  const accounts = [...new Set(loans.map((l) => l.account).filter((a): a is string => Boolean(a)))]
  const balances = await loanAccountBalances(ctx.supabase, ctx.companyId, accounts, day)
  const views: OwnerLoanView[] = loans.map((l, i) => {
    const party = parties.get(l.party_id)
    const related = l.related_to_party_id ? parties.get(l.related_to_party_id) : null
    const { id, party_id, related_to_party_id, created_at: _created, ...rest } = l
    void _created
    return {
      ...rest,
      owner_loan_id: id,
      party: {
        party_id,
        name: party?.name ?? '',
        kind: party?.kind ?? 'person',
        identity: party ? (party.kind === 'company' ? party.org_number : party.personnummer_masked) : null,
      },
      related_to: related_to_party_id ? { party_id: related_to_party_id, name: related?.name ?? '' } : null,
      loan_ban: assessments[i]!,
      interest: interest
        .filter((r) => r.owner_loan_id === id)
        .map((r) => ({ income_year: r.income_year, interest_amount: r.interest_amount, tax_withheld: r.tax_withheld })),
    }
  })
  return {
    as_of: day,
    loans: views,
    reconciliation: reconcileLoanAccounts(loans, balances, day),
    flagged: views.filter((v) => v.status === 'active' && v.loan_ban.status === 'prohibited').length,
  }
}

// ── The special list (ABL 21:10) ─────────────────────────────────────

export interface SpecialListRow {
  owner_loan_id: string
  party_name: string
  kind: 'loan' | 'security'
  relation_sv: string
  start_date: string
  principal: number
  outstanding: number
  interest_rate: number | null
  terms: string | null
  exception_sv: string
  exception_note: string | null
  status: string
  repaid_on: string | null
}

/**
 * The loans and security granted under the business-loan exception or a
 * dispensation that were owed at any time in the year: the list the
 * company keeps for each year, ten years (ABL 21:10). The year is the
 * calendar year; a company with a broken räkenskapsår picks the year its
 * räkenskapsår ends in.
 */
export function specialList(view: OwnerLoansView, year: number): SpecialListRow[] {
  return view.loans
    .filter((l) => l.direction === 'lends' && l.loan_ban.special_list && loanActiveBetween(l, `${year}-01-01`, `${year}-12-31`))
    .map((l) => ({
      owner_loan_id: l.owner_loan_id,
      party_name: l.party.name,
      kind: l.kind,
      relation_sv: l.relation === 'none' ? l.loan_ban.circle.map((c) => LOAN_CIRCLE_LABELS_SV[c]).join(', ') : LOAN_RELATION_LABELS_SV[l.relation],
      start_date: l.start_date,
      principal: l.principal,
      outstanding: l.outstanding,
      interest_rate: l.interest_rate,
      terms: l.terms,
      exception_sv: LOAN_EXCEPTION_LABELS_SV[l.exception],
      exception_note: l.exception_note,
      status: l.status,
      repaid_on: l.repaid_on,
    }))
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.party_name.localeCompare(b.party_name, 'sv'))
}

// ── The ÅRL 5:18 note ────────────────────────────────────────────────

/**
 * The note on loans and security to board members and the VD on a balance
 * day, for the årsredovisning to read. Board and VD per company_roles on
 * that day; a person who is both is counted as VD.
 */
export async function loadBoardLoansNote(ctx: OperationContext, balanceDate: string): Promise<BoardLoansNote> {
  const loans = (await loadOwnerLoans(ctx.supabase, ctx.companyId)).filter((l) => l.direction === 'lends' && loanActiveOn(l, balanceDate))
  if (loans.length === 0) return buildBoardLoansNote(balanceDate, [])
  const insiders = (await loadInsiderTimeline(ctx))(balanceDate)
  const items: BoardNoteLoan[] = []
  for (const l of loans) {
    const category = insiders.ceo.has(l.party_id) ? 'ceo' : insiders.board.has(l.party_id) ? 'board' : null
    if (!category) continue
    items.push({ kind: l.kind, amount: roundOre(l.kind === 'loan' ? l.outstanding : l.principal), interest_rate: l.interest_rate, terms: l.terms, category })
  }
  return buildBoardLoansNote(balanceDate, items)
}
