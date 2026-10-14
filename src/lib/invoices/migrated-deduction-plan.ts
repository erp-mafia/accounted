/**
 * What the post-migration deduction step does with one imported invoice.
 *
 * A Visma invoice issued under fakturamodellen (ROT, RUT, grön teknik)
 * arrived without its deduction: the import had no slot for it and Visma's
 * SIE keeps the whole invoice on 1510, so the buyer reads as owing
 * Skatteverket's share and the invoice can never be requested here
 * (crm#1144). This planner decides, from the provider's invoice detail and
 * the invoice as it stands, which of four things happens:
 *
 *   apply        write the deduction (lib/invoices/migrated-deduction-apply.ts
 *                books debit 1513 / credit 1510 first), after which the
 *                invoice reads exactly like one issued here;
 *   status_only  a part-paid import left at sent/overdue becomes
 *                partially_paid, nothing else changes;
 *   skip         nothing to do (no deduction, already applied, requested
 *                or refused at the provider);
 *   review       the invoice needs a person: the reason says why.
 *
 * Per the provider's claim state (Visma TaxDeductionStatus):
 *   - open (0/1): buyer paid nothing → apply, status unchanged; paid part of
 *     their share → apply, partially_paid; paid all of it → apply, paid on
 *     the provider's payment date, unless the provider's remaining amount
 *     differs from ours or that payment year's begäran deadline has passed
 *     (HUSFL: 31 January the year after the payment), which go to review;
 *   - requested (2): Skatteverket's payout arrives on 1510 where the provider
 *     booked it and is matched as an ordinary payment: never applied, only
 *     the status repair;
 *   - rejected (3): the buyer owes it and it is already on 1510: same.
 *
 * Pure: no I/O. The personnummer leaves here in plain text for the apply
 * service to encrypt; it must never reach a response or a log.
 */
import type { DeductionType } from '@/types'
import type { HouseholdDeductionDto, SalesInvoiceDto } from '@/lib/providers/dto'
import { roundOre } from '@/lib/money'
import { expandPersonnummerTo12, validatePersonnummer } from '@/lib/salary/personnummer-format'
import { deductionLineIssues, type DeductionLineIssueCode } from './rot-rut-rules'
import { isPastRequestDeadline } from './rot-rut-file'

export interface PlanItem {
  id: string
  sort_order: number
  line_type?: string | null
  quantity: number | null
  unit: string | null
  line_total: number
  vat_amount: number
  deduction_type?: string | null
}

export interface PlanInvoice {
  id: string
  invoice_number: string | null
  status: string
  currency: string | null
  total: number
  paid_amount: number | null
  deduction_total: number | null
  /** Every row, in sort order. */
  items: PlanItem[]
  /** invoice_payments rows recorded here since the import. */
  payment_count: number
  /** The live rot_rut_reclassification voucher, when one exists. */
  reclassification_voucher_id: string | null
}

/** The state apply_migrated_invoice_deduction refuses to move away from. */
export interface PlanExpected {
  status: string
  total: number
  paid_amount: number
  payment_count: number
  item_count: number
}

export interface PlannedItemDeduction {
  id: string
  line_total: number
  vat_amount: number
  deduction_amount: number
  labor_hours: number | null
  work_type: string
  housing_designation: string | null
  apartment_number: string | null
  brf_org_number: string | null
}

export type MigratedDeductionReviewReason =
  | 'not_sek'
  | 'several_buyers'
  | 'personnummer'
  | 'rows_differ'
  | 'unmapped_work_type'
  | 'missing_hours'
  | 'missing_property'
  | 'deduction_not_whole_kronor'
  | 'deduction_exceeds_remaining'
  | 'provider_remaining_differs'
  | 'payment_date_missing'
  | 'past_deadline'
  | 'voucher_without_deduction'

export type MigratedDeductionSkipReason =
  | 'no_deduction'
  | 'requested_at_provider'
  | 'rejected_at_provider'
  | 'already_applied'
  | 'not_open'

export type MigratedDeductionPlan =
  | {
      outcome: 'apply'
      invoiceId: string
      deductionType: DeductionType
      deductionTotal: number
      /** 12 digits, plain text: encrypt before it leaves the server. */
      personnummer: string
      /** The day the buyer's whole share was paid; null while it is not. */
      paidOn: string | null
      resultingStatus: string
      expected: PlanExpected
      items: PlannedItemDeduction[]
      /** A voucher an earlier run posted before it stopped: reuse it. */
      reuseVoucherId: string | null
    }
  | { outcome: 'status_only'; invoiceId: string; expected: PlanExpected }
  | { outcome: 'skip'; invoiceId: string; reason: MigratedDeductionSkipReason }
  | {
      outcome: 'review'
      invoiceId: string
      reason: MigratedDeductionReviewReason
      deductionType?: DeductionType
      deductionTotal?: number
      paidOn?: string
    }
  /** Applied here earlier, and the provider has since sent it to Skatteverket. */
  | { outcome: 'double_request'; invoiceId: string; deductionTotal: number }

const OPEN_STATUSES = ['sent', 'overdue', 'partially_paid']
const HOUR_UNITS = /^(h|hr|hrs|tim|tim\.|timme|timmar|hour|hours)$/i
/** invoice_items.labor_hours is NUMERIC(5,2). */
const MAX_LABOR_HOURS = 999.99

const LINE_ISSUE_REASON: Record<DeductionLineIssueCode, MigratedDeductionReviewReason> = {
  workTypeMissing: 'unmapped_work_type',
  workTypeMismatch: 'unmapped_work_type',
  hoursMissing: 'missing_hours',
  gronTeknikWorkTypeMissing: 'unmapped_work_type',
  gronTeknikWorkTypeMismatch: 'unmapped_work_type',
  gronTeknikHoursMissing: 'missing_hours',
  gronTeknikMixed: 'unmapped_work_type',
}

function expectedOf(invoice: PlanInvoice): PlanExpected {
  return {
    status: invoice.status,
    total: roundOre(invoice.total),
    paid_amount: roundOre(invoice.paid_amount ?? 0),
    payment_count: invoice.payment_count,
    item_count: invoice.items.length,
  }
}

/** A buyer's personnummer as 12 digits, or null when it is missing or invalid. */
export function normalizeBuyerPersonnummer(value: string | undefined, now: Date): string | null {
  if (!value) return null
  const digits = expandPersonnummerTo12(value, now)
  if (!digits || !validatePersonnummer(digits).valid) return null
  return digits
}

interface PropertyFields {
  housing_designation: string | null
  apartment_number: string | null
  brf_org_number: string | null
}

/** BRF orgnr as the invoice schema accepts it (lib/api/schemas.ts). */
const BRF_ORG_NUMBER = /^(\d{6}-?\d{4}|16\d{10})$/

function propertyFields(property: HouseholdDeductionDto['property']): PropertyFields | null {
  const designation = property?.designation?.trim() || null
  if (!designation) return null
  if (property?.type === 'apartment') {
    const brf = property.brfOrgNumber?.trim() || null
    if (!brf || !BRF_ORG_NUMBER.test(brf)) return null
    return { housing_designation: null, apartment_number: designation, brf_org_number: brf }
  }
  return { housing_designation: designation, apartment_number: null, brf_org_number: null }
}

/**
 * The deduction over the work rows in proportion to each row's price
 * including moms; the öre the rounding leaves go on the largest row.
 */
export function spreadDeduction(total: number, bases: number[]): number[] {
  const sum = bases.reduce((acc, base) => acc + base, 0)
  if (!(sum > 0)) return bases.map(() => 0)
  const shares = bases.map((base) => roundOre((total * base) / sum))
  const residual = roundOre(total - shares.reduce((acc, share) => acc + share, 0))
  if (residual !== 0) {
    let largest = 0
    for (let index = 1; index < bases.length; index++) {
      if (bases[index] > bases[largest]) largest = index
    }
    shares[largest] = roundOre(shares[largest] + residual)
  }
  return shares
}

function hoursOf(item: PlanItem, providerHours: number | undefined): number | null {
  if (providerHours != null && providerHours > 0) return providerHours
  if (item.unit && HOUR_UNITS.test(item.unit.trim()) && item.quantity != null && item.quantity > 0) {
    return item.quantity
  }
  return null
}

/** The date part of a provider timestamp, or null. */
function dateOnly(value: string | undefined): string | null {
  const match = value?.match(/^\d{4}-\d{2}-\d{2}/)
  return match ? match[0] : null
}

export function planMigratedDeduction(
  invoice: PlanInvoice,
  dto: SalesInvoiceDto,
  options: { today: string; now?: Date },
): MigratedDeductionPlan {
  const deduction = dto.householdDeduction
  const invoiceId = invoice.id
  const expected = expectedOf(invoice)
  const total = expected.total
  const paid = expected.paid_amount

  // Already carries a deduction: the step ran (or the invoice was given one
  // here). The only question left is whether the provider has since sent it
  // to Skatteverket too.
  const hasDeduction =
    (invoice.deduction_total ?? 0) > 0 || invoice.items.some((item) => item.deduction_type)
  if (hasDeduction) {
    if (invoice.reclassification_voucher_id && deduction?.providerState === 'requested') {
      return { outcome: 'double_request', invoiceId, deductionTotal: roundOre(invoice.deduction_total ?? 0) }
    }
    return { outcome: 'skip', invoiceId, reason: 'already_applied' }
  }

  const plan = planOpen(invoice, dto, deduction, expected, total, paid, options)
  // A voucher posted by a run that stopped before the write: anything but
  // completing it leaves 1513 holding a claim the invoice does not show.
  if (invoice.reclassification_voucher_id && plan.outcome !== 'apply') {
    return {
      outcome: 'review',
      invoiceId,
      reason: 'voucher_without_deduction',
      deductionType: deduction?.kind,
      deductionTotal: deduction ? roundOre(deduction.amount) : undefined,
    }
  }
  return plan
}

function planOpen(
  invoice: PlanInvoice,
  dto: SalesInvoiceDto,
  deduction: HouseholdDeductionDto | undefined,
  expected: PlanExpected,
  total: number,
  paid: number,
  options: { today: string; now?: Date },
): MigratedDeductionPlan {
  const invoiceId = invoice.id
  if (!OPEN_STATUSES.includes(invoice.status) || !(total > 0)) {
    return { outcome: 'skip', invoiceId, reason: 'not_open' }
  }
  const statusRepair: MigratedDeductionPlan | null =
    (invoice.status === 'sent' || invoice.status === 'overdue') && paid > 0 && paid < total
      ? { outcome: 'status_only', invoiceId, expected }
      : null

  if (!deduction || !(deduction.amount > 0)) {
    return statusRepair ?? { outcome: 'skip', invoiceId, reason: 'no_deduction' }
  }
  if (deduction.providerState === 'requested') {
    return statusRepair ?? { outcome: 'skip', invoiceId, reason: 'requested_at_provider' }
  }
  if (deduction.providerState === 'rejected') {
    return statusRepair ?? { outcome: 'skip', invoiceId, reason: 'rejected_at_provider' }
  }

  const deductionType = deduction.kind
  const deductionTotal = roundOre(deduction.amount)
  const review = (reason: MigratedDeductionReviewReason, paidOn?: string): MigratedDeductionPlan => ({
    outcome: 'review',
    invoiceId,
    reason,
    deductionType,
    deductionTotal,
    paidOn,
  })

  if ((invoice.currency || 'SEK').toUpperCase() !== 'SEK') return review('not_sek')
  // One buyer per invoice: the invoice holds one personnummer (#3314).
  if (deduction.buyers.length > 1) return review('several_buyers')
  const personnummer = normalizeBuyerPersonnummer(deduction.buyers[0]?.personnummer, options.now ?? new Date())
  if (!personnummer) return review('personnummer')

  // The provider's rows must be the rows stored here, one for one.
  const rows = dto.lines
  if (rows.length !== invoice.items.length) return review('rows_differ')
  for (let index = 0; index < rows.length; index++) {
    if (Math.abs(roundOre(rows[index].lineExtensionAmount.value) - roundOre(invoice.items[index].line_total)) >= 0.01) {
      return review('rows_differ')
    }
  }
  const workIndexes = rows
    .map((row, index) => (row.householdWork && invoice.items[index].line_type !== 'text' ? index : -1))
    .filter((index) => index >= 0)
  if (workIndexes.length === 0) return review('rows_differ')
  if (workIndexes.some((index) => rows[index].householdWork!.workType == null)) return review('unmapped_work_type')

  if (deductionTotal !== Math.trunc(deductionTotal)) return review('deduction_not_whole_kronor')
  if (deductionTotal > roundOre(total - paid)) return review('deduction_exceeds_remaining')

  const bases = workIndexes.map((index) =>
    roundOre(invoice.items[index].line_total + invoice.items[index].vat_amount),
  )
  if (deductionTotal > roundOre(bases.reduce((acc, base) => acc + base, 0))) return review('rows_differ')

  let property: PropertyFields | null = propertyFields(deduction.property)
  if (deductionType !== 'rut' && !property) return review('missing_property')
  property ??= { housing_designation: null, apartment_number: null, brf_org_number: null }

  const shares = spreadDeduction(deductionTotal, bases)
  const items: PlannedItemDeduction[] = workIndexes.map((index, position) => {
    const item = invoice.items[index]
    const work = rows[index].householdWork!
    return {
      id: item.id,
      line_total: roundOre(item.line_total),
      vat_amount: roundOre(item.vat_amount),
      deduction_amount: shares[position],
      labor_hours: hoursOf(item, work.hours),
      work_type: work.workType!,
      ...property,
    }
  })

  // The same per-row bar an invoice issued here must clear.
  const issues = deductionLineIssues(items.map((item) => ({ ...item, deduction_type: deductionType })))
  if (issues.length > 0) return review(LINE_ISSUE_REASON[issues[0].code])
  if (items.some((item) => item.labor_hours != null && item.labor_hours > MAX_LABOR_HOURS)) {
    return review('missing_hours')
  }

  const base = {
    outcome: 'apply' as const,
    invoiceId,
    deductionType,
    deductionTotal,
    personnummer,
    expected,
    items,
    reuseVoucherId: invoice.reclassification_voucher_id,
  }
  const customerShare = roundOre(total - deductionTotal)
  if (paid === 0) return { ...base, paidOn: null, resultingStatus: invoice.status }
  if (paid < customerShare) return { ...base, paidOn: null, resultingStatus: 'partially_paid' }

  // The buyer has paid their whole share. The begäran reports the day that
  // payment arrived, which only the provider knows; it is trusted only when
  // the provider's open amount is exactly ours, i.e. no payment was
  // registered on either side since the migration.
  if (Math.abs(roundOre(dto.paymentStatus.balance.value) - roundOre(total - paid)) >= 0.01) {
    return review('provider_remaining_differs')
  }
  const paidOn = dateOnly(dto.paymentStatus.lastPaymentDate)
  if (!paidOn || paidOn > options.today) return review('payment_date_missing')
  if (isPastRequestDeadline(paidOn, options.today)) return review('past_deadline', paidOn)
  return { ...base, paidOn, resultingStatus: 'paid' }
}
