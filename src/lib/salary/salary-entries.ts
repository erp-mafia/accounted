import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import { activateAccounts } from '@/lib/bookkeeping/chart-of-accounts-service'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  normalizeLineDimensions,
  type DimensionAliasInput,
  type LineDimensions,
} from '@/lib/bookkeeping/dimension-resolver'
import {
  applyDimensionRules,
  fetchActiveDimensionRules,
  isDimensionRuleExemptSource,
} from '@/lib/bookkeeping/dimension-rules'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { createLogger } from '@/lib/logger'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { linkBasisColumns } from '@/lib/links/stamp'
import { roundOre } from '@/lib/money'
import { categoryForTemplateGroup } from '@/lib/posting/categories'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { creditNatural, debitNatural } from '@/lib/bookkeeping/line-side'
import {
  SALARY_ACCOUNTS,
  isTaxFreeReimbursementType,
  lineItemAccount,
  netDeductionAccount,
  vacationLiabilityChangeAccount,
  type MoneyLineItemType,
  type SalaryAccountContext,
} from './account-mapping'
import { isTextRow } from './text-rows'
import { isBenefitItemType } from './benefit-payments'
import {
  computeDeclaredAvgifterWithOverrides,
  isFSkattStatus,
  resolveDeclaredAvgifterParams,
} from './declared-avgifter'
import { calculateLoneVaxlingPensionProvision } from './lonevaxling'
import { computeRegionalSupport, regionalSupportEnabled } from './regional-support'
import {
  linkRunRemeasurement,
  planVacationLiabilityRemeasure,
  upsertRunRemeasurement,
} from './vacation-liability-remeasure'
import type { RemeasurePlan } from './vacation-liability-plan'
import { runRemeasuresVacationLiability } from './vacation-liability-method'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'

const log = createLogger('salary-entries')

export interface SalaryRunEmployee {
  employee_id: string
  employment_type: string
  // employees.personnel_category: arbetare book the 70xx wage series,
  // tjänstemän 72xx (lineItemAccount). Missing reads tjänsteman.
  personnel_category?: string | null
  gross_salary: number
  tax_withheld: number
  net_salary: number
  avgifter_amount: number
  avgifter_rate: number
  // Declared-avgifter inputs (see lib/salary/declared-avgifter.ts): the
  // whole-krona 2731 liability is computed Skatteverket's way from the
  // FILED underlag (never basis overrides: those don't reach the IUs), not
  // by truncating the öre-exact cost. Optional: rows from legacy callers
  // without them fall back to the öre-exact liability.
  avgifter_basis?: number
  avgifter_category?: string | null
  // True when avgifter_amount carries a manual review override: the split
  // then mirrors the AGI's override path (per-category truncation of the
  // overridden amounts) instead of the underlag computation, so the
  // operator's adjustment stays on 2731 and never books as fake utjämning.
  avgifter_amount_overridden?: boolean
  vacation_accrual: number
  vacation_accrual_avgifter: number
  // Dimensions PR8: the employee's default bag ({sie_dim_no: code}), read
  // from employees.default_dimensions by the book routes. P&L cost lines
  // (löner, avgifter, semester, pension, SLP) split per bag; the
  // balance-sheet/settlement legs (2710, 1930, 2731, 29xx, 2740, 2514)
  // stay aggregated: a liability toward Skatteverket or the bank has no
  // per-employee dimension. Replaces the never-wired cost_center/project
  // pair that predated the JSONB substrate.
  default_dimensions?: Record<string, string>
  line_items: Array<{
    item_type: string
    amount: number
    account_number: string | null
    is_net_deduction: boolean
    is_gross_deduction: boolean
    /** On a benefit payment: the benefit it pays for (its default account follows it). */
    benefit_type?: string | null
  }>
  // Löneväxling pension (if applicable)
  pension_contribution?: number
  pension_slp?: number
}

export interface SalaryRunData {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  calculation_params?: Record<string, unknown> | null
  employees: SalaryRunEmployee[]
}

/** The salary_runs columns the run input reads. */
export interface SalaryRunRow {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  calculation_params?: Record<string, unknown> | null
}

/**
 * A salary_run_employees row joined with the employee columns and line
 * items the booking reads. Structural: the book runner's wider roster row
 * and the preview route's narrower select both satisfy it.
 */
export interface SalaryRosterRow {
  employee_id: string
  gross_salary: number
  tax_withheld: number
  tax_withheld_override?: number | null
  net_salary: number
  avgifter_amount: number
  avgifter_amount_override?: number | null
  avgifter_basis?: number | null
  avgifter_rate: number
  avgifter_category?: string | null
  vacation_accrual: number
  vacation_accrual_avgifter: number
  employee?: {
    employment_type?: string | null
    personnel_category?: string | null
    default_dimensions?: Record<string, string> | null
    f_skatt_status?: string | null
  } | null
  line_items?: Array<Record<string, unknown>> | null
}

/**
 * Map the stored run + roster rows to the engine input. ONE mapping for the
 * booking (book-run.ts) and the journal preview route: the preview used to
 * carry its own copy of these rules and drifted (no tax_withheld override,
 * no employee dimensions), which is the class of bug behind feedback seq
 * 384229 where the previewed salary voucher did not balance.
 *
 * Per-employee overrides (advanced mode) flow into the ledger: the tax
 * override replaces tax_withheld and the net moves by the same amount.
 * F-skatt payees form no underlag for arbetsgivaravgifter: the AGI
 * hard-ignores avgifter overrides on such rows (isFSkattRow), so the booking
 * must too, or the ledger would carry social charges the declaration
 * provably excludes. The avgifter basis is deliberately the UN-overridden
 * one (a basis override never reaches the filed IU fields, so Skatteverket
 * computes from these values regardless), zeroed for F-skatt rows; an
 * amount override is flagged instead so the 2731 split mirrors the AGI's
 * override path. The employee's dimensions bag and personnel category are
 * read live from the employee row, so preview and booking show the same
 * split and the same wage accounts (the booking stamps the category it read
 * on the roster row before it posts, book-run.ts).
 */
export function salaryRunDataFromRows(run: SalaryRunRow, roster: SalaryRosterRow[]): SalaryRunData {
  return {
    id: run.id,
    period_year: run.period_year,
    period_month: run.period_month,
    payment_date: run.payment_date,
    voucher_series: run.voucher_series,
    total_gross: run.total_gross,
    total_tax: run.total_tax,
    total_net: run.total_net,
    total_avgifter: run.total_avgifter,
    total_vacation_accrual: run.total_vacation_accrual,
    // The exact payroll-rate snapshot approved with this run: reading current
    // config here could change SLP between calculation and booking.
    calculation_params: run.calculation_params ?? null,
    employees: roster.map((sre) => {
      const fSkatt = isFSkattStatus(sre.employee?.f_skatt_status)
      const taxWithheld = sre.tax_withheld_override ?? sre.tax_withheld
      return {
        employee_id: sre.employee_id,
        employment_type: sre.employee?.employment_type || 'employee',
        personnel_category: sre.employee?.personnel_category ?? null,
        gross_salary: sre.gross_salary,
        tax_withheld: taxWithheld,
        net_salary: sre.net_salary + (sre.tax_withheld - taxWithheld),
        avgifter_amount: fSkatt
          ? sre.avgifter_amount
          : sre.avgifter_amount_override ?? sre.avgifter_amount,
        avgifter_rate: sre.avgifter_rate,
        avgifter_basis: fSkatt ? 0 : (sre.avgifter_basis as number),
        avgifter_category: sre.avgifter_category ?? null,
        avgifter_amount_overridden: !fSkatt && sre.avgifter_amount_override != null,
        vacation_accrual: sre.vacation_accrual,
        vacation_accrual_avgifter: sre.vacation_accrual_avgifter,
        default_dimensions: sre.employee?.default_dimensions ?? undefined,
        line_items: (sre.line_items || []).map((li) => ({
          item_type: li.item_type as string,
          amount: li.amount as number,
          account_number: li.account_number as string | null,
          is_net_deduction: li.is_net_deduction as boolean,
          is_gross_deduction: li.is_gross_deduction as boolean,
          ...(li.benefit_type ? { benefit_type: li.benefit_type as string } : {}),
        })),
      }
    }),
  }
}

/** Voucher description shared by the booking and the preview: "Lön YYYY-MM". */
export function salaryRunDescription(run: Pick<SalaryRunRow, 'period_year' | 'period_month'>): string {
  return `Lön ${run.period_year}-${String(run.period_month).padStart(2, '0')}`
}

function resolveLoneVaxlingPension(run: SalaryRunData): SalaryRunData {
  const snapshotSlpRate = run.calculation_params?.slpRate

  return {
    ...run,
    employees: run.employees.map((employee) => {
      // Preserve the explicit amounts accepted by this low-level API. Current
      // booking callers omit them and derive from the frozen line-item set.
      if (
        employee.pension_contribution !== undefined ||
        employee.pension_slp !== undefined
      ) {
        return employee
      }

      const salaryReduction = employee.line_items
        .filter((line) => line.item_type === 'gross_deduction_pension')
        .reduce((sum, line) => sum + line.amount, 0)

      if (roundOre(Math.abs(salaryReduction)) === 0) return employee
      if (typeof snapshotSlpRate !== 'number') {
        throw new Error('Salary run calculation snapshot is missing the SLP rate')
      }

      const provision = calculateLoneVaxlingPensionProvision(
        salaryReduction,
        snapshotSlpRate,
      )
      return {
        ...employee,
        pension_contribution: provision.pensionContribution,
        pension_slp: provision.slpOnPension,
      }
    }),
  }
}

/** The source_type every salary-run voucher carries; source_id is the run id. */
const SALARY_SOURCE_TYPE = 'salary_payment' as const

type SalaryVoucherSlot = 'salary' | 'avgifter' | 'vacation' | 'pension'

interface SalaryRunVoucher {
  slot: SalaryVoucherSlot
  description: string
  lines: CreateJournalEntryLineInput[]
}

interface PostedLine extends DimensionAliasInput {
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
}

/** A posted voucher of this run, as the resume lookup reads it. */
type PostedRunVoucher = Omit<JournalEntry, 'lines'> & { lines?: PostedLine[] | null }

export const SALARY_RUN_PARTIALLY_BOOKED = 'SALARY_RUN_PARTIALLY_BOOKED' as const

/**
 * The run already has posted vouchers that are not the ones this booking
 * would post: a duplicate from an earlier retry, or a voucher posted before
 * the run's data or the company's policy changed. Booking on would post the
 * affärshändelse twice, so it stops and names the vouchers: reverse them
 * (storno) and book again. The Swedish message is composed here with the
 * voucher labels (thrown_message_sv in the error registry).
 */
export class SalaryRunPartiallyBookedError extends Error {
  readonly code = SALARY_RUN_PARTIALLY_BOOKED
  readonly details: { voucher_numbers: string[]; entry_ids: string[] }
  readonly messageEn: string

  constructor(entries: Array<Pick<JournalEntry, 'id' | 'voucher_series' | 'voucher_number'>>) {
    const labels = entries.map((entry) => formatVoucher(entry)).join(', ')
    super(
      `Lönekörningen har redan bokförda verifikationer (${labels}) från ett tidigare försök som inte stämmer med körningen. Återför dem och bokför sedan lönekörningen igen.`,
    )
    this.name = 'SalaryRunPartiallyBookedError'
    this.messageEn = `The salary run already has posted vouchers (${labels}) from an earlier attempt that do not match the run. Reverse them, then book the run again.`
    this.details = {
      voucher_numbers: entries.map((entry) => formatVoucher(entry)),
      entry_ids: entries.map((entry) => entry.id),
    }
  }
}

/**
 * The business event of a salary run (kind payroll.salary_paid), for the
 * posting port: ONE event for the run's 1 to 4 verifikat, recorded while
 * POSTING_EVENTS is shadow or strict and never built while it is off. Pure.
 *
 * Dated the payment date, the date every verifikat of the run carries; the
 * subject is the run. A run of one employee names that employee as party
 * (type and id only); a run of several names none, as no single employee is
 * the counterparty. The amount is the run's bruttolön (salary_runs.total_gross)
 * in SEK, the figure the run is known by; arbetsgivaravgifter,
 * semesteravsättning and pension stay in the lines. Nothing per employee goes
 * into the evidence. The idempotency key is the run's own, so a booking
 * resumed after an interruption links the vouchers it posts to the event the
 * first attempt recorded: a run has one event however many attempts posted
 * its vouchers.
 */
export function salaryRunBusinessEvent(run: SalaryRunData, linkBasis: LinkBasisColumns): BusinessEventDraft {
  const amount = Math.abs(run.total_gross)
  const only = run.employees.length === 1 ? run.employees[0] : null
  return {
    kind: 'payroll.salary_paid',
    category: categoryForTemplateGroup('personnel'),
    occurredOn: run.payment_date,
    subject: { type: 'salary_run', id: run.id },
    party: only ? { type: 'employee', id: only.employee_id } : null,
    // A run's amounts are in the ledger currency.
    currency: 'SEK',
    amount,
    amountSek: amount,
    evidence: { link_basis: linkBasis.link_basis, link_evidence: linkBasis.link_evidence ?? undefined },
    pendingOperationId: linkBasis.link_evidence?.pending_operation_id ?? null,
    mappingVersion: mappingVersion('salaryRun'),
    jurisdiction: 'SE',
    idempotencyKey: `payroll.salary_paid:salary_run:${run.id}`,
  }
}

/**
 * Create all journal entries for a salary run: 1-4 vouchers
 *   1. Salary: gross salary expenses, tax withholding, net payment
 *   2. Avgifter (if the run has any): employer contributions expense + liability
 *   3. Vacation (if anything accrues): accrual expense + liability, with avgifter.
 *      A run calculated under salary_vacation_liability_method 'remeasure'
 *      books the semesterlöneskuld remeasurement instead: computed liability
 *      as of the payment date, after this run, minus what 2920/2940 hold
 *      (lib/salary/vacation-liability-remeasure.ts), and stores the frozen
 *      calculation behind it before anything posts.
 *   4. Pension (if löneväxling): pension provision + SLP
 *
 * All entries use source_type 'salary_payment' and source_id = the run id.
 *
 * The set is posted through createJournalEntries(): every voucher passes the
 * engine's checks (required dimension rules, registry, accounts, balance)
 * before the first one is numbered, so a refusal on any voucher posts none.
 * It goes through the posting port (postJournalEntrySet), which hands the
 * set to createJournalEntries unchanged; while POSTING_EVENTS is shadow or
 * strict it first records the run's one event (salaryRunBusinessEvent) and
 * every draft of the set is linked to it before the first number is drawn.
 *
 * Retry-safe: a posting that stopped partway (a transient error after voucher
 * 1 committed) leaves the run unbooked with vouchers in the ledger. The next
 * call reads the run's posted vouchers and adopts each one that is exactly the
 * voucher it would post now (same date, accounts, amounts and dimensions),
 * then posts only the missing ones. A posted voucher of the run that matches
 * nothing (a duplicate, or one booked from data that has changed since) stops
 * the booking with SalaryRunPartiallyBookedError instead of posting on.
 */
export async function createSalaryRunEntries(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<{
  salaryEntry: JournalEntry | null
  avgifterEntry: JournalEntry | null
  vacationEntry: JournalEntry | null
  pensionEntry: JournalEntry | null
}> {
  const postingRun = resolveLoneVaxlingPension(run)
  const entryDate = run.payment_date
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new Error(`Ingen öppen räkenskapsperiod för datum ${entryDate}`)
  }

  const desc = salaryRunDescription(run)

  // The bank account the net pay leaves from: the company's primary cash
  // account, the same resolver the preview route calls (issue #3097).
  const bankAccount = await resolvePrimaryBankAccount(supabase, companyId, log)

  // Under the 'remeasure' method the vacation verifikat is the
  // remeasurement as of the payment date (the run's own posted vouchers left
  // out of the starting balance, so a resumed booking computes the same).
  const remeasure = runRemeasuresVacationLiability(run.calculation_params)
    ? await planRunVacationRemeasure(supabase, companyId, run)
    : null

  // The four line sets come from the same builder the preview route renders,
  // so what the user approved on screen is what posts.
  const built = buildSalaryRunEntryLines(postingRun, desc, bankAccount, remeasure?.lines)

  await activateSalaryAccounts(supabase, companyId, userId, built)

  // The run's vouchers in posting order. Each exists only when it has lines:
  // salary only with pay, tax or a payout (a run whose only amount is a
  // förmånsvärde has none, since benefits book no salary line, crm#1596),
  // avgifter only when the run has any, vacation only when something
  // accrues, pension only with löneväxling (per deductions-lonevaxling.md:
  // pension = löneväxling × 1.058 on 7410/2740, SLP = pension × 24.26% on
  // 7533/2514). A voucher that is not in the set is absent, so a retry
  // neither posts nor expects it. The journal preview route drops the same
  // empty vouchers.
  const vouchers: SalaryRunVoucher[] = []
  if (built.salaryLines.length > 0) {
    vouchers.push({ slot: 'salary', description: desc, lines: built.salaryLines })
  }
  if (built.avgifterLines.length > 0) {
    vouchers.push({ slot: 'avgifter', description: `${desc}: Arbetsgivaravgifter`, lines: built.avgifterLines })
  }
  if (built.vacationLines.length > 0) {
    vouchers.push({ slot: 'vacation', description: vacationVoucherDescription(desc, remeasure !== null), lines: built.vacationLines })
  }
  if (built.pensionLines.length > 0) {
    vouchers.push({ slot: 'pension', description: `${desc}: Pensionsavsättning`, lines: built.pensionLines })
  }
  // A run with nothing to post is a nollkörning, which bookLoadedRun books
  // without calling here. Reaching this with no voucher means the run's
  // totals and its rows disagree: refuse rather than mark it booked with no
  // verifikat at all.
  if (vouchers.length === 0) {
    throw new Error('Lönekörningen har belopp men inga rader att bokföra. Beräkna om körningen och försök igen.')
  }

  // What an earlier, interrupted attempt already posted for this run is
  // adopted, never posted again.
  const adopted = await adoptPostedRunVouchers(supabase, companyId, run.id, entryDate, vouchers)
  const pending = vouchers.filter((voucher) => !adopted.has(voucher.slot))

  // The remeasurement's underlag exists before its verifikat does.
  if (remeasure) await upsertRunRemeasurement(supabase, { companyId, salaryRunId: run.id, plan: remeasure })

  const inputs = pending.map((voucher): CreateJournalEntryInput => {
    log.info(`Creating salary run entry "${voucher.description}": ${voucher.lines.length} lines`)
    return {
      fiscal_period_id: fiscalPeriodId,
      entry_date: entryDate,
      description: voucher.description,
      source_type: SALARY_SOURCE_TYPE,
      source_id: run.id,
      voucher_series: run.voucher_series,
      lines: voucher.lines,
    }
  })
  const created = await postingPort.postJournalEntrySet({
    supabase,
    companyId,
    userId,
    // Built only while the port is on: off, the set is posted with the call it always was.
    event: () => salaryRunBusinessEvent(run, linkBasisColumns('user_created')),
    inputs,
  })

  const bySlot = new Map<SalaryVoucherSlot, JournalEntry>(adopted)
  pending.forEach((voucher, index) => bySlot.set(voucher.slot, created[index]))
  const vacationEntry = bySlot.get('vacation')
  if (remeasure && vacationEntry) {
    const linkError = await linkRunRemeasurement(supabase, { companyId, salaryRunId: run.id, journalEntryId: vacationEntry.id })
    if (linkError) {
      log.warn('semesterlöneskuld remeasurement stored but not linked to its verifikat', {
        salaryRunId: run.id,
        journalEntryId: vacationEntry.id,
        message: linkError,
      })
    }
  }
  return {
    salaryEntry: bySlot.get('salary') ?? null,
    avgifterEntry: bySlot.get('avgifter') ?? null,
    vacationEntry: bySlot.get('vacation') ?? null,
    pensionEntry: bySlot.get('pension') ?? null,
  }
}

/** The vacation verifikat's text: the accrual, or the remeasurement under 'remeasure'. */
export function vacationVoucherDescription(desc: string, remeasure: boolean): string {
  return remeasure ? `${desc}: Semesterlöneskuld` : `${desc}: Semesteravsättning`
}

/**
 * The remeasurement a run calculated under 'remeasure' books: as of its
 * payment date, counting the run itself as booked. Shared by the booking and
 * the journal preview route, so the previewed vacation verifikat is the one
 * that posts on unchanged books.
 */
export async function planRunVacationRemeasure(
  supabase: SupabaseClient,
  companyId: string,
  run: Pick<SalaryRunData, 'id' | 'payment_date'>,
): Promise<RemeasurePlan> {
  const planned = await planVacationLiabilityRemeasure(supabase, companyId, run.payment_date, { inFlightRunId: run.id })
  if (!planned.ok) {
    throw new Error(
      planned.code === 'VALIDATION_ERROR'
        ? `Ingen räkenskapsperiod täcker ${run.payment_date}, så semesterlöneskulden kan inte räknas om.`
        : 'Semesterlöneskulden kunde inte räknas om. Försök igen.',
    )
  }
  return planned.data
}

/**
 * The run's already-posted vouchers, matched to the vouchers this booking
 * would post. The ledger is the record of what an earlier attempt did:
 * source_type 'salary_payment' + source_id = run id, status 'posted' (a
 * reversed voucher is 'reversed' and its storno has source_type 'storno', so
 * a voucher the user has already cancelled is not counted).
 *
 * A posted voucher is adopted for a slot only when it IS that slot's voucher
 * as it would be posted now: same entry date and the same lines (account,
 * debit, credit, and dimensions after the company's default/fixed rules).
 * Anything else is refused by name, because posting on would book the same
 * affärshändelse twice. Fails closed: when the lookup itself fails, nothing
 * is posted.
 */
async function adoptPostedRunVouchers(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
  entryDate: string,
  vouchers: SalaryRunVoucher[],
): Promise<Map<SalaryVoucherSlot, JournalEntry>> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(account_number, debit_amount, credit_amount, dimensions)')
    .eq('company_id', companyId)
    .eq('source_type', SALARY_SOURCE_TYPE)
    .eq('source_id', runId)
    .eq('status', 'posted')
    .order('voucher_number', { ascending: true })

  if (error) {
    throw new Error(
      `Kunde inte kontrollera lönekörningens tidigare bokförda verifikationer: ${error.message}`,
    )
  }
  const posted = (data ?? []) as PostedRunVoucher[]
  const adopted = new Map<SalaryVoucherSlot, JournalEntry>()
  if (posted.length === 0) return adopted

  // Compare with the lines as the engine would store them now: its
  // default/fixed dimension rules are part of what would be posted.
  const rules = isDimensionRuleExemptSource(SALARY_SOURCE_TYPE)
    ? []
    : await fetchActiveDimensionRules(supabase, companyId)
  if (rules === null) {
    // Without the rules a match cannot be proven, and a mismatch would tell
    // the user to reverse vouchers that may be right. Stop; a retry decides.
    throw new Error('Kunde inte läsa företagets dimensionsregler. Försök igen.')
  }
  const wanted = vouchers.map((voucher) => ({
    slot: voucher.slot,
    fingerprint: linesFingerprint(applyDimensionRules(voucher.lines, rules)),
  }))

  const strays: PostedRunVoucher[] = []
  for (const entry of posted) {
    const fingerprint = linesFingerprint(entry.lines ?? [])
    const match =
      entry.entry_date === entryDate
        ? wanted.find((w) => !adopted.has(w.slot) && w.fingerprint === fingerprint)
        : undefined
    if (match) {
      // Callers read the header (id, voucher number); `lines` on this row is
      // only the column subset selected for the comparison above.
      adopted.set(match.slot, entry as unknown as JournalEntry)
    } else {
      strays.push(entry)
    }
  }

  if (strays.length > 0) {
    throw new SalaryRunPartiallyBookedError(strays)
  }
  log.warn('resuming an interrupted salary booking: already-posted vouchers are adopted, not posted again', {
    companyId,
    salaryRunId: runId,
    adopted: [...adopted.entries()].map(([slot, entry]) => ({ slot, entryId: entry.id })),
  })
  return adopted
}

/**
 * Order-independent identity of a voucher's lines: account, debit and credit
 * in öre, and the normalized dimensions bag. Descriptions are left out on
 * purpose: an inline rättelse may reword them without changing what was
 * booked.
 */
function linesFingerprint(
  lines: Array<
    DimensionAliasInput & {
      account_number: string
      debit_amount?: number | string | null
      credit_amount?: number | string | null
    }
  >,
): string {
  return lines
    .map((line) =>
      [
        line.account_number,
        Math.round(Number(line.debit_amount || 0) * 100),
        Math.round(Number(line.credit_amount || 0) * 100),
        dimensionsBagKey(normalizeLineDimensions(line)),
      ].join('\u0000'),
    )
    .sort()
    .join('\u0001')
}

export interface SalaryRunEntryLines {
  /** Entry 1: löner, kostnadsersättning, nettolöneavdrag, personalskatt, nettolön (on the bank account). */
  salaryLines: CreateJournalEntryLineInput[]
  /** Entry 2: arbetsgivaravgifter (7510 / 2731 / 3740); empty when the run has no avgifter. */
  avgifterLines: CreateJournalEntryLineInput[]
  /** Entry 3: semesteravsättning; empty when nothing accrues. */
  vacationLines: CreateJournalEntryLineInput[]
  /** Entry 4: löneväxling pension + SLP; empty without löneväxling. */
  pensionLines: CreateJournalEntryLineInput[]
}

/**
 * Pure "run -> journal lines" for all four salary vouchers. The booking
 * (createSalaryRunEntries) posts exactly these; the journal preview route
 * renders exactly these. One builder, so a rule that lives here (benefit
 * line types carry no cash flow, the base-salary remainder, the whole-krona
 * 2731 split, dimension buckets) cannot be present in one and missing in
 * the other: feedback seq 384229 was a preview that debited 7385 for a
 * bilförmån with no counter line because it had its own copy of the loop.
 *
 * `bankAccount` is the ledger account the net pay is credited on. It is a
 * fact about the company, not about payroll, so the builder takes it instead
 * of carrying a constant: callers pass resolvePrimaryBankAccount() (a
 * hardcoded 1930 here booked salaries off a company's real bank account,
 * issue #3097).
 */
export function buildSalaryRunEntryLines(
  run: SalaryRunData,
  desc: string,
  bankAccount: string,
  /** The remeasurement's lines under 'remeasure' (planRunVacationRemeasure); absent books the accrual. */
  vacationRemeasureLines?: CreateJournalEntryLineInput[],
): SalaryRunEntryLines {
  const postingRun = resolveLoneVaxlingPension(run)
  const totalVacation = postingRun.employees.reduce((sum, e) => sum + e.vacation_accrual, 0)
  const totalVacationAvgifter = postingRun.employees.reduce(
    (sum, e) => sum + e.vacation_accrual_avgifter,
    0,
  )
  const totalPension = postingRun.employees.reduce((sum, e) => sum + (e.pension_contribution || 0), 0)
  const totalSlp = postingRun.employees.reduce((sum, e) => sum + (e.pension_slp || 0), 0)
  return {
    salaryLines: buildSalaryLines(postingRun, desc, bankAccount),
    avgifterLines: buildAvgifterLines(postingRun, desc),
    vacationLines: vacationRemeasureLines
      ? vacationRemeasureLines
      : totalVacation > 0 || totalVacationAvgifter > 0
        ? buildVacationLines(postingRun, desc, totalVacation, totalVacationAvgifter)
        : [],
    pensionLines: totalPension > 0 ? buildPensionLines(postingRun, desc, totalSlp) : [],
  }
}

/**
 * Entry 1: Salary booking.
 *
 * Debit:  7010/7210/7220/7240 Löner (per employee: lineItemAccount)
 * Debit:  7321/7331 skattefri kostnadsersättning, 2820 utlägg repaid with
 *         the salary (outside gross, inside the net payout)
 * Credit: 2710 Personalskatt (total tax withheld)
 * Credit: `bankAccount`, the company's bank account (total net salary)
 */
function buildSalaryLines(
  run: SalaryRunData,
  desc: string,
  bankAccount: string,
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []

  // Aggregate salary expenses by (account, dimensions), dimensions PR8. The
  // employee's bag is part of the aggregation identity, so two employees on
  // the same account but different kostnadsställen produce separate lines
  // instead of collapsing (the dead cost_center/project fields never did
  // this). Dimension-less runs collapse to one bucket per account and book
  // byte-identically to before.
  interface ExpenseBucket {
    account: string
    dimensions?: LineDimensions
    amount: number
  }
  const expenseBuckets = new Map<string, ExpenseBucket>()
  const addExpense = (account: string, dimensions: LineDimensions | undefined, amount: number) => {
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const bucket = expenseBuckets.get(key) ?? { account, dimensions, amount: 0 }
    bucket.amount += amount
    expenseBuckets.set(key, bucket)
  }

  // Net deductions (nettolöneavdrag) reduce the payout but not gross pay: the
  // withheld amount is owed elsewhere (union fee, advance repayment, benefit
  // co-payment), so each one books on its mapped settlement account instead of
  // a 7xxx expense. Skipping them entirely (the old behavior) left the entry
  // unbalanced by exactly the deducted amount. Like the 2710/1930 legs these
  // stay aggregated and undimensioned. The same map carries the 2820 relief
  // of utlägg repaid with the salary (positive, so it books as a debit).
  const netDeductionBuckets = new Map<string, number>()

  for (const emp of run.employees) {
    // Every line without an override, and the base salary remainder, books
    // on the account the resolver gives this employee (owner, board member,
    // arbetare or tjänsteman).
    const ctx = employeeAccountContext(emp)
    const salaryAccount = lineItemAccount('monthly_salary', ctx)
    const dimensions = coerceDimensionsBag(emp.default_dimensions)

    // Add salary line items that are cash expenses
    // Förmånsvärden (benefits) are excluded: they affect the tax base and the
    // avgiftsunderlag (so they reach 2710 and the avgifter entry) but are no
    // cost or payment, so they get no line of their own; the employer's real
    // cost of the benefit (leasing, the meals) is booked from its invoice
    // (swedish-payroll: förmånsvärde to the AGI, avgifter on it; crm#1354).
    // Every benefit type, from the one list
    // (benefit-payments.ts BENEFIT_ITEM_TYPES), whether the row was derived
    // from the employee or entered on the payslip.
    let lineItemTotal = 0
    for (const li of emp.line_items) {
      // A text row is words on the payslip, no money: nothing to book.
      if (isTextRow(li)) continue
      // Öresavrundning: part of the payout (the 1930 credit uses the rounded
      // net) but NOT part of gross salary, so it must stay out of
      // lineItemTotal: the baseRemainder below reconciles line items against
      // gross_salary, and counting the rounding there would shrink the base
      // salary debit by the same amount and unbalance the entry.
      if (li.item_type === 'oresavrundning') {
        const account = li.account_number || lineItemAccount('oresavrundning', ctx)
        addExpense(account, dimensions, li.amount)
        continue
      }
      if (li.is_net_deduction) {
        const account = li.account_number || netDeductionAccount(li.item_type as MoneyLineItemType, li.benefit_type, ctx)
        netDeductionBuckets.set(account, (netDeductionBuckets.get(account) ?? 0) + li.amount)
        continue
      }
      // Kostnadsersättning (utlägg, skattefritt traktamente, skattefri
      // milersättning): inside the 1930 net credit but outside gross, so like
      // the öresavrundning it must stay out of lineItemTotal or the base
      // salary debit would shrink by the same amount. Travel types are P&L
      // costs and follow the employee bag; an utlägg repayment relieves the
      // liability the registration credited (2820), a settlement leg that
      // stays aggregated and undimensioned like 2710/1930.
      if (isTaxFreeReimbursementType(li.item_type)) {
        const account = li.account_number || lineItemAccount(li.item_type as MoneyLineItemType, ctx)
        if (li.item_type === 'expense_reimbursement') {
          netDeductionBuckets.set(account, (netDeductionBuckets.get(account) ?? 0) + li.amount)
        } else {
          addExpense(account, dimensions, li.amount)
        }
        continue
      }
      if (li.is_gross_deduction) continue
      if (isBenefitItemType(li.item_type)) continue // No cash flow for förmånsvärden
      const account = li.account_number || lineItemAccount(li.item_type as MoneyLineItemType, ctx)
      addExpense(account, dimensions, li.amount)
      lineItemTotal += li.amount
    }

    // Ensure the debit side always equals gross_salary (minus gross deductions,
    // which the credit side doesn't book either). If line items don't cover the
    // full gross amount, book the remainder to the default salary account so the
    // entry balances. Without this, an employee with overtime line items but no
    // base-salary line item would fail the check_journal_entry_balance() trigger.
    const baseRemainder = Math.round((emp.gross_salary - lineItemTotal) * 100) / 100
    if (baseRemainder !== 0) {
      addExpense(salaryAccount, dimensions, baseRemainder)
    }
  }

  // Debit: Salary expense accounts (one line per account+dimensions bucket).
  // Judged on the rounded amount: a bucket whose rows cancel to float noise
  // would otherwise post a 0,00 line.
  for (const bucket of expenseBuckets.values()) {
    if (roundOre(bucket.amount) === 0) continue
    if (bucket.amount > 0) {
      lines.push({
        account_number: bucket.account,
        debit_amount: roundOre(bucket.amount),
        credit_amount: 0,
        line_description: `${desc}: ${accountLabel(bucket.account)}`,
        dimensions: bucket.dimensions,
      })
    } else {
      // Negative amounts (deductions) become credits
      lines.push({
        account_number: bucket.account,
        debit_amount: 0,
        credit_amount: roundOre(Math.abs(bucket.amount)),
        line_description: `${desc}: ${accountLabel(bucket.account)}`,
        dimensions: bucket.dimensions,
      })
    }
  }

  // Net deduction settlement lines. Payslip amounts are negative (withheld
  // from the employee), which credits the account; a positive correction
  // books as a debit repayment.
  for (const [account, amount] of netDeductionBuckets) {
    const rounded = roundOre(Math.abs(amount))
    if (rounded === 0) continue
    lines.push({
      account_number: account,
      debit_amount: amount > 0 ? rounded : 0,
      credit_amount: amount < 0 ? rounded : 0,
      line_description: `${desc}: ${accountLabel(account)}`,
    })
  }

  // Credit: Tax withholding
  const totalTax = run.employees.reduce((sum, e) => sum + e.tax_withheld, 0)
  if (totalTax > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.TAX_WITHHELD,
      debit_amount: 0,
      credit_amount: Math.round(totalTax * 100) / 100,
      line_description: `${desc}: Personalskatt`,
    })
  }

  // Credit: Net salary to bank
  const totalNet = run.employees.reduce((sum, e) => sum + e.net_salary, 0)
  if (totalNet > 0) {
    lines.push({
      account_number: bankAccount,
      debit_amount: 0,
      credit_amount: Math.round(totalNet * 100) / 100,
      line_description: `${desc}: Nettolön`,
    })
  }

  return lines
}

/**
 * Bucket a per-employee amount by the employee's dimensions bag, dimensions
 * PR8. Used for the P&L cost side of the avgifter/vacation/pension entries:
 * one debit line per distinct bag, while the liability credit stays a single
 * aggregated line. Zero amounts are skipped; each bucket is rounded and the
 * caller credits the SUM OF ROUNDED buckets so the entry balances by
 * construction regardless of how the total partitions. `accountOf` splits
 * the buckets per cost account as well (the vacation accrual's 7090/7290);
 * without it every bucket carries the empty account.
 */
function bucketByEmployeeDimensions(
  employees: SalaryRunEmployee[],
  amountOf: (emp: SalaryRunEmployee) => number,
  accountOf: (emp: SalaryRunEmployee) => string = () => '',
): Array<{ account: string; dimensions?: LineDimensions; amount: number }> {
  const buckets = new Map<string, { account: string; dimensions?: LineDimensions; amount: number }>()
  for (const emp of employees) {
    const amount = amountOf(emp)
    if (!amount) continue
    const account = accountOf(emp)
    const dimensions = coerceDimensionsBag(emp.default_dimensions)
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const bucket = buckets.get(key) ?? { account, dimensions, amount: 0 }
    bucket.amount += amount
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, amount: roundOre(b.amount) }))
    .filter((b) => b.amount !== 0)
}

/**
 * Split the öre-exact avgifter total into the whole-krona 2731 liability and
 * the 3740 utjämning remainder.
 *
 * The liability is the DECLARED amount (computeDeclaredAvgifter: Skatteverket's
 * per-sats computation on whole-krona underlag), which on öre-bearing rosters
 * sits kronor, not just öre, below the exact cost: 4 employees at 30 000,99 kr
 * cost 37 705,24 exactly while Skatteverket draws 37 704, so 1,24 kr books to
 * 3740. The remainder is bounded by ~1 kr per employee (per-IU truncation)
 * plus per-sats truncation; a remainder outside [0, employees + 2) means the
 * roster's stored amounts diverge from its underlag (legacy rows without
 * basis columns, corrupt data), and the entry falls back to the legacy
 * öre-exact liability rather than manufacturing a fake utjämning.
 *
 * Manual avgifter_amount overrides (flagged EXPLICITLY: a small override
 * inside the magnitude band would otherwise book the operator's deliberate
 * adjustment as rounding income on 3740) contribute their manual amounts per
 * category instead of the underlag computation: the identical hybrid the AGI
 * generator files and the payment file pays
 * (computeDeclaredAvgifterWithOverrides), so the booked 2731, the
 * declaration and the payment stay one number, and colleagues of an
 * overridden employee keep their SKV-exact declared amounts.
 *
 * Exported so the journal preview route computes the identical split.
 */
export function splitAvgifterLiability(
  run: {
    employees: Array<
      Pick<
        SalaryRunEmployee,
        | 'avgifter_amount'
        | 'avgifter_basis'
        | 'avgifter_rate'
        | 'avgifter_category'
        | 'avgifter_amount_overridden'
      >
    >
    calculation_params?: Record<string, unknown> | null
  },
  roundedAvgifter: number,
): { liabilityAvgifter: number; oresutjamning: number } {
  if (roundedAvgifter <= 0) {
    return { liabilityAvgifter: roundedAvgifter, oresutjamning: 0 }
  }
  // Non-overridden rows need the underlag; overridden rows carry their own
  // amount. A roster from a legacy caller without basis columns falls back.
  const haveInputs = run.employees.every(
    (e) => e.avgifter_amount_overridden === true || typeof e.avgifter_basis === 'number',
  )
  if (!haveInputs) {
    return { liabilityAvgifter: roundedAvgifter, oresutjamning: 0 }
  }
  const declared = computeDeclaredAvgifterWithOverrides(
    run.employees.map((e) => ({
      basis: e.avgifter_basis ?? 0,
      rate: e.avgifter_rate,
      category: e.avgifter_category ?? null,
      overrideAmount: e.avgifter_amount_overridden === true ? e.avgifter_amount : null,
    })),
    resolveDeclaredAvgifterParams(run.calculation_params),
  )
  const remainder = roundOre(roundedAvgifter - declared.totalAmount)
  // Per-IU truncation loses under 1 kr per employee and each truncation cell
  // strictly under 1 kr more; a remainder outside this band means the
  // roster's stored amounts diverge from its underlag (corrupt or legacy
  // data), and the entry keeps the öre-exact liability rather than
  // manufacturing a fake utjämning.
  const maxTruncationDrift = run.employees.length + 2
  if (remainder < 0 || remainder >= maxTruncationDrift) {
    return { liabilityAvgifter: roundedAvgifter, oresutjamning: 0 }
  }
  return { liabilityAvgifter: declared.totalAmount, oresutjamning: remainder }
}

/**
 * The regionalt stöd avdrag (FK476) a run's AGI subtracts from the avgift,
 * from the booking's own roster rows: 0 unless the run was calculated with
 * company_settings.salary_regional_support on (regional-support.ts), or when
 * the roster lacks the underlag columns (legacy callers). The AGI generator
 * computes the same figure from the same snapshot and rows.
 */
export function regionalSupportDeduction(
  run: {
    employees: Array<
      Pick<SalaryRunEmployee, 'avgifter_amount' | 'avgifter_basis' | 'avgifter_rate' | 'avgifter_category' | 'avgifter_amount_overridden'>
    >
    calculation_params?: Record<string, unknown> | null
  },
): number {
  if (!regionalSupportEnabled(run.calculation_params)) return 0
  if (!run.employees.every((e) => e.avgifter_amount_overridden === true || typeof e.avgifter_basis === 'number')) {
    return 0
  }
  const support = computeRegionalSupport(
    run.employees.map((e) => ({
      basis: e.avgifter_basis ?? 0,
      rate: e.avgifter_rate,
      category: e.avgifter_category ?? null,
      overrideAmount: e.avgifter_amount_overridden === true ? e.avgifter_amount : null,
    })),
  )
  return support?.deduction ?? 0
}

/**
 * Entry 2: Arbetsgivaravgifter.
 *
 * Debit:  7510 Lagstadgade sociala avgifter (per dimensions bucket, exact öre)
 * Credit: 2731 Avräkning sociala avgifter (whole kronor: the amount
 *         Skatteverket computes from the declared underlag and draws)
 * Credit: 3740 Öres- och kronutjämning (the remainder)
 * Credit: 7510 Avdrag regionalt stöd (whole kronor, PH 208): the FK476
 *         avdrag lowers both the avgift cost and the 2731 liability, so
 *         2731 still equals the FK487 the AGI files and Skatteverket draws
 *
 * 2731 holds the declared amount (computeDeclaredAvgifter: per-sats on
 * whole-krona underlag, the same number the AGI's FK487 carries): crediting
 * the öre-exact cost would leave a residual on 2731 after the whole-krona
 * skattekonto draw. The 7510 cost side stays exact: the difference is a
 * settlement artifact, not a cost reduction. Post-booking AGI edits
 * (borttag, overrides set during review) still require a storno + rebook:
 * this alignment covers the booking as calculated.
 */
function buildAvgifterLines(run: SalaryRunData, desc: string): CreateJournalEntryLineInput[] {
  const buckets = bucketByEmployeeDimensions(run.employees, (e) => e.avgifter_amount)
  // No avgifter anywhere in the run (a run that only repays utlägg, F-skatt
  // payees, employees with 0% avgifter): nothing to book, so no voucher,
  // exactly as vacation and pension produce none when nothing accrues. The
  // zero-shaped lines this used to return could never post: the engine
  // refuses a voucher whose total is zero.
  if (buckets.length === 0) return []
  const roundedAvgifter = roundOre(buckets.reduce((sum, b) => sum + b.amount, 0))
  const { liabilityAvgifter: grossLiability, oresutjamning } = splitAvgifterLiability(run, roundedAvgifter)
  // Never more than the liability it reduces (it cannot be: 10 % of the
  // underlag stays below the avgift on it), so the entry always balances.
  const regionalDeduction = Math.min(regionalSupportDeduction(run), Math.max(grossLiability, 0))
  const liabilityAvgifter = roundOre(grossLiability - regionalDeduction)

  const lines: CreateJournalEntryLineInput[] = [
    ...buckets.map((bucket): CreateJournalEntryLineInput => ({
      account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
      ...debitNatural(bucket.amount),
      line_description: `${desc}: Arbetsgivaravgifter`,
      dimensions: bucket.dimensions,
    })),
    // Skip the liability line when it would be 0/0 (verifikat noise): the
    // utjämning carries the whole sub-1-krona amount, or the buckets net to
    // zero.
    ...(liabilityAvgifter !== 0
      ? [
          {
            account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
            ...creditNatural(liabilityAvgifter),
            line_description: `${desc}: Arbetsgivaravgifter`,
          } satisfies CreateJournalEntryLineInput,
        ]
      : []),
    ...(oresutjamning > 0
      ? [
          {
            account_number: SALARY_ACCOUNTS.ORESUTJAMNING,
            debit_amount: 0,
            credit_amount: oresutjamning,
            line_description: `${desc}: Öres- och kronutjämning`,
          } satisfies CreateJournalEntryLineInput,
        ]
      : []),
    ...(regionalDeduction > 0
      ? [
          {
            account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
            debit_amount: 0,
            credit_amount: regionalDeduction,
            line_description: `${desc}: Avdrag regionalt stöd`,
          } satisfies CreateJournalEntryLineInput,
        ]
      : []),
  ]

  return lines
}

/**
 * Entry 3: Vacation accrual.
 *
 * Debit:  7090/7290 Förändring semesterlöneskuld (per employee:
 *         vacationLiabilityChangeAccount)
 * Credit: 2920 Upplupna semesterlöner
 * Debit:  7519 Sociala avgifter semester
 * Credit: 2940 Upplupna sociala avgifter
 */
function buildVacationLines(
  run: SalaryRunData,
  desc: string,
  totalVacation: number,
  totalVacationAvgifter: number
): CreateJournalEntryLineInput[] {
  const roundedVacation = Math.round(totalVacation * 100) / 100
  const roundedAvgifter = Math.round(totalVacationAvgifter * 100) / 100

  const lines: CreateJournalEntryLineInput[] = []

  if (roundedVacation > 0) {
    // Dimensions PR8: cost per bag, liability aggregated. The credit equals
    // the sum of the rounded debit buckets so the entry balances by
    // construction (may differ from round(total) by an öre when partitioned).
    // The cost splits per employee account as well (7090 arbetare, 7290
    // everyone else); the 2920 credit stays one line.
    const buckets = bucketByEmployeeDimensions(
      run.employees,
      (e) => e.vacation_accrual,
      (e) => vacationLiabilityChangeAccount(employeeAccountContext(e)),
    )
    const creditTotal = roundOre(buckets.reduce((sum, b) => sum + b.amount, 0))
    lines.push(
      ...buckets.map((bucket): CreateJournalEntryLineInput => ({
        account_number: bucket.account,
        ...debitNatural(bucket.amount),
        line_description: `${desc}: Semesteravsättning`,
        dimensions: bucket.dimensions,
      })),
      {
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
        ...creditNatural(creditTotal),
        line_description: `${desc}: Semesteravsättning`,
      }
    )
  }

  if (roundedAvgifter > 0) {
    const buckets = bucketByEmployeeDimensions(run.employees, (e) => e.vacation_accrual_avgifter)
    const creditTotal = roundOre(buckets.reduce((sum, b) => sum + b.amount, 0))
    lines.push(
      ...buckets.map((bucket): CreateJournalEntryLineInput => ({
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
        ...debitNatural(bucket.amount),
        line_description: `${desc}: Sociala avgifter på semester`,
        dimensions: bucket.dimensions,
      })),
      {
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
        ...creditNatural(creditTotal),
        line_description: `${desc}: Sociala avgifter på semester`,
      }
    )
  }

  return lines
}

/**
 * Entry 4: Pension provisions + SLP (löneväxling).
 *
 * Debit:  7410 Pensionsförsäkringspremier
 * Credit: 2740 Skuld pensionsförsäkringar
 * Debit:  7533 Särskild löneskatt på pensionskostnader (24.26%)
 * Credit: 2514 Beräknad särskild löneskatt
 *
 * Per deductions-lonevaxling.md: pension = löneväxling × 1.058
 */
function buildPensionLines(
  run: SalaryRunData,
  desc: string,
  totalSlp: number
): CreateJournalEntryLineInput[] {
  const roundedSlp = Math.round(totalSlp * 100) / 100

  // Dimensions PR8: pension + SLP cost per bag, liabilities aggregated.
  // Credits equal the sum of the rounded debit buckets (balance by
  // construction). The caller gates on totalPension > 0.
  const pensionBuckets = bucketByEmployeeDimensions(run.employees, (e) => e.pension_contribution || 0)
  const pensionCredit = roundOre(pensionBuckets.reduce((sum, b) => sum + b.amount, 0))

  const lines: CreateJournalEntryLineInput[] = [
    ...pensionBuckets.map((bucket): CreateJournalEntryLineInput => ({
      account_number: SALARY_ACCOUNTS.PENSION_EXPENSE,
      ...debitNatural(bucket.amount),
      line_description: `${desc}: Pensionsförsäkringspremier`,
      dimensions: bucket.dimensions,
    })),
    {
      account_number: SALARY_ACCOUNTS.PENSION_LIABILITY,
      ...creditNatural(pensionCredit),
      line_description: `${desc}: Pensionsförsäkringspremier`,
    },
  ]

  if (roundedSlp > 0) {
    const slpBuckets = bucketByEmployeeDimensions(run.employees, (e) => e.pension_slp || 0)
    const slpCredit = roundOre(slpBuckets.reduce((sum, b) => sum + b.amount, 0))
    lines.push(
      ...slpBuckets.map((bucket): CreateJournalEntryLineInput => ({
        account_number: SALARY_ACCOUNTS.SLP_EXPENSE,
        ...debitNatural(bucket.amount),
        line_description: `${desc}: Särskild löneskatt 24,26%`,
        dimensions: bucket.dimensions,
      })),
      {
        account_number: SALARY_ACCOUNTS.SLP_LIABILITY,
        ...creditNatural(slpCredit),
        line_description: `${desc}: Särskild löneskatt 24,26%`,
      }
    )
  }

  return lines
}

// ============================================================
// Helpers
// ============================================================

function employeeAccountContext(emp: SalaryRunEmployee): SalaryAccountContext {
  return { employmentType: emp.employment_type, personnelCategory: emp.personnel_category }
}

/**
 * Make every account the salary run posts to usable before the engine
 * resolves them: standard BAS accounts missing from the chart are created,
 * deactivated ones (a 7210 switched off before the first employee) are
 * reactivated. Both go through activateAccounts, the one activation path the
 * chart page and the API use. A number that is neither in the chart nor in
 * BAS 2026 is refused instead of invented.
 *
 * The set is read off the built lines, so it is exactly what posts: a company
 * that books only arbetare gets 7010 activated and not an unused 7210, and a
 * resolver rule can never post to an account this step skipped.
 */
async function activateSalaryAccounts(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  built: SalaryRunEntryLines,
): Promise<void> {
  const needed = new Set<string>()
  for (const lines of Object.values(built) as CreateJournalEntryLineInput[][]) {
    for (const line of lines) needed.add(line.account_number)
  }

  const outcome = await activateAccounts({ supabase, companyId, userId, log }, [...needed])
  // activateAccounts has logged the database error behind the failure.
  if (!outcome.ok) throw new Error(`Kunde inte aktivera lönekontona (${outcome.code})`)
  if (outcome.dryRun) return
  if (outcome.data.unknown.length > 0) {
    throw new AccountsNotInChartError(outcome.data.unknown)
  }

  const { activated, reactivated, accounts } = outcome.data
  if (activated + reactivated > 0) {
    log.info(`Activated ${activated} and reactivated ${reactivated} salary accounts: ${accounts.map((a) => a.account_number).join(', ')}`)
  }
}

function accountLabel(account: string): string {
  const labels: Record<string, string> = {
    '7010': 'Löner kollektivanställda',
    '7081': 'Sjuklöner kollektivanställda',
    '7082': 'Semesterlöner kollektivanställda',
    '7210': 'Löner tjänstemän',
    '7220': 'Löner företagsledare',
    '7240': 'Styrelsearvoden',
    '7281': 'Sjuklöner',
    '7282': 'Sjuklöner företagsledare',
    '7285': 'Semesterlöner',
    '7286': 'Semesterlöner företagsledare',
    '7321': 'Traktamenten skattefria',
    '7322': 'Traktamenten skattepliktiga',
    [resolveAccountRole(PINNED_JURISDICTION, 'foreign_per_diem_tax_free')]: 'Traktamenten skattefria, utlandet',
    [resolveAccountRole(PINNED_JURISDICTION, 'foreign_per_diem_taxable')]: 'Traktamenten skattepliktiga, utlandet',
    '7331': 'Bilersättningar skattefria',
    '7332': 'Bilersättningar skattepliktiga',
    '7385': 'Kostnader för fri bil',
    '2820': 'Kortfristiga skulder till anställda',
    '1613': 'Övriga förskott',
    '2794': 'Fackföreningsavgifter',
    '2799': 'Övriga löneavdrag',
    '3740': 'Öres- och kronutjämning',
  }
  return labels[account] || `Konto ${account}`
}
