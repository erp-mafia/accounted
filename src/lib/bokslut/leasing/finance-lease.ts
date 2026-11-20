import { roundOre } from '@/lib/money'

/**
 * Finansiell leasing for a lessee under K3 kapitel 20, for a company that
 * does not use the legal-entity relief of 20.29 (every finansiellt
 * leasingavtal treated as operationellt). Opt-in per company: the relief is
 * what every company does today and stays the default.
 *
 *   20.5  At the start: an asset and a liability at the lower of the asset's
 *         verkliga värde and the nuvärde of the minimileaseavgifter (20.6),
 *         discounted at the implicit rate (20.7) or, when that cannot be
 *         determined, the marginal borrowing rate (20.8); direct costs of
 *         entering the lease are added to the asset.
 *   20.9  Each payment splits into interest and amortisation by the
 *         effective interest method, and each financial year carries the
 *         interest of the liability outstanding during it (accrued, not
 *         paid). Variable fees (20.10) are a cost when they arise.
 *   20.11 The asset is depreciated like an owned asset of its kind, over the
 *         lease term or the useful life if shorter, unless ownership will
 *         pass to the lessee with reasonable certainty.
 *
 * Pure: the lease and the period come in, the schedule and the journal
 * lines of the year come out. The year's payments are booked as they are
 * today, on the leasing cost account; the year-end adjustment moves them to
 * interest and amortisation, accrues the interest of the year, and adds
 * the depreciation. This module does not touch the asset register
 * (lib/bokslut/assets): the leased asset's depreciation is computed here,
 * straight-line by month.
 */

export interface FinanceLease {
  id: string
  name: string
  /** Leasingavtalets ingående, the first day of a month; also the first period's start. */
  startDate: string
  /** The asset's verkliga värde at the start (20.5). */
  fairValue: number
  /** Fixed payment per period (minimileaseavgift, 20.6), excluding VAT, variable fees and service. */
  payment: number
  numberOfPayments: number
  periodsPerYear: 1 | 2 | 4 | 12
  /** Payments at the start of each period (in advance), the common Swedish lease, or at its end. */
  paymentsInAdvance: boolean
  /** Restvärde guaranteed by the lessee, paid with the last payment (20.6). */
  guaranteedResidual: number
  /** Annual implicit rate (20.7) or marginal borrowing rate (20.8), percent. */
  annualRatePercent: number
  /** Direct costs of entering the lease, added to the asset (20.5). */
  directCosts: number
  /** Useful life in months, for 20.11 when shorter than the lease term or ownership passes. */
  usefulLifeMonths: number
  ownershipTransfers: boolean
}

export interface LeasePeriodRow {
  index: number
  /** The payment's date. */
  date: string
  payment: number
  interest: number
  amortisation: number
  /** Liability after the payment. */
  liability: number
  /** The months (from the lease start, end exclusive) over which this payment's interest accrued. */
  accrualFromMonth: number
  accrualToMonth: number
}

export interface LeaseSchedule {
  presentValue: number
  initialLiability: number
  initialAsset: number
  /** The effective rate per period on the recognised liability. */
  ratePerPeriod: number
  rows: LeasePeriodRow[]
  depreciationMonths: number
}

const ore = (value: number) => roundOre(value) || 0

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

function presentValueAt(lease: FinanceLease, rate: number): number {
  const exponent = (k: number) => (lease.paymentsInAdvance ? k : k + 1)
  let value = 0
  for (let k = 0; k < lease.numberOfPayments; k++) value += lease.payment * Math.pow(1 + rate, -exponent(k))
  return value + lease.guaranteedResidual * Math.pow(1 + rate, -exponent(lease.numberOfPayments - 1))
}

export function leaseSchedule(lease: FinanceLease): LeaseSchedule {
  const statedRate = Math.pow(1 + lease.annualRatePercent / 100, 1 / lease.periodsPerYear) - 1
  const monthsPerPeriod = 12 / lease.periodsPerYear
  const n = lease.numberOfPayments
  const presentValue = ore(presentValueAt(lease, statedRate))
  const initialLiability = ore(Math.min(lease.fairValue, presentValue))
  const initialAsset = ore(initialLiability + lease.directCosts)

  // When the fair value is the lower amount, the rate that amortises the
  // recognised liability to zero is higher than the stated one (20.9).
  let rate = statedRate
  if (initialLiability < presentValue) {
    let lo = statedRate
    let hi = statedRate + 1
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2
      if (presentValueAt(lease, mid) > initialLiability) lo = mid
      else hi = mid
    }
    rate = (lo + hi) / 2
  }

  const rows: LeasePeriodRow[] = []
  let liability = initialLiability
  for (let k = 0; k < n; k++) {
    const due = ore(lease.payment + (k === n - 1 ? lease.guaranteedResidual : 0))
    // In advance, the first payment carries no interest; every other payment
    // pays the interest of the period before it.
    const interestFree = lease.paymentsInAdvance && k === 0
    const interest = interestFree ? 0 : ore(liability * rate)
    const amortisation = k === n - 1 ? ore(liability) : ore(due - interest)
    liability = ore(liability - amortisation)
    const paidAtMonth = (lease.paymentsInAdvance ? k : k + 1) * monthsPerPeriod
    rows.push({
      index: k,
      date: addMonths(lease.startDate, paidAtMonth),
      payment: due,
      interest: ore(due - amortisation),
      amortisation,
      liability,
      accrualFromMonth: interestFree ? paidAtMonth : paidAtMonth - monthsPerPeriod,
      accrualToMonth: paidAtMonth,
    })
  }

  const leaseMonths = n * monthsPerPeriod
  const depreciationMonths = lease.ownershipTransfers ? lease.usefulLifeMonths : Math.min(leaseMonths, lease.usefulLifeMonths)
  return { presentValue, initialLiability, initialAsset, ratePerPeriod: rate, rows, depreciationMonths }
}

export interface LeaseYear {
  /** Payments made in the year: what the leasing cost account holds. */
  payments: number
  /** Interest within the year's payments. */
  interestPaid: number
  /** Interest the year carries (20.9), accrued by month. */
  interestExpense: number
  amortisation: number
  depreciation: number
  /** Liability on balansdagen (excluding accrued interest) and its part due within a year (ÅRL 3 kap. 4 b §). */
  closingLiability: number
  dueWithinOneYear: number
  /** Interest accrued but not paid on balansdagen. */
  accruedInterest: number
  /** Carrying amount of the asset on balansdagen. */
  closingAsset: number
}

/** The lease's figures for the financial year [periodStart, periodEnd], both month-aligned. */
export function leaseYear(lease: FinanceLease, schedule: LeaseSchedule, periodStart: string, periodEnd: string): LeaseYear {
  const fyFrom = monthsBetween(lease.startDate, periodStart)
  const fyTo = monthsBetween(lease.startDate, periodEnd) + 1
  const inYear = schedule.rows.filter((row) => row.date >= periodStart && row.date <= periodEnd)
  const sum = (rows: LeasePeriodRow[], pick: (row: LeasePeriodRow) => number) =>
    ore(rows.reduce((total, row) => total + pick(row), 0))

  const share = (row: LeasePeriodRow, from: number, to: number) => {
    const span = row.accrualToMonth - row.accrualFromMonth
    if (span <= 0) return 0
    const overlap = Math.max(0, Math.min(row.accrualToMonth, to) - Math.max(row.accrualFromMonth, from))
    return overlap / span
  }
  const interestExpense = sum(schedule.rows, (row) => row.interest * share(row, fyFrom, fyTo))
  // Accrued on balansdagen: the part of unpaid periods that has already run.
  const accruedInterest = sum(
    schedule.rows.filter((row) => row.date > periodEnd),
    (row) => row.interest * share(row, -Infinity, fyTo),
  )

  const paidByEnd = schedule.rows.filter((row) => row.date <= periodEnd)
  const closingLiability = paidByEnd.length > 0 ? paidByEnd[paidByEnd.length - 1].liability : schedule.initialLiability
  const nextYearEnd = addMonths(periodEnd, 12)
  const dueWithinOneYear = sum(
    schedule.rows.filter((row) => row.date > periodEnd && row.date <= nextYearEnd),
    (row) => row.amortisation,
  )

  // Straight-line by month from the start (20.11 with kapitel 17).
  const monthly = schedule.initialAsset / schedule.depreciationMonths
  const before = Math.max(0, Math.min(schedule.depreciationMonths, fyFrom))
  const through = Math.max(0, Math.min(schedule.depreciationMonths, fyTo))
  const accumulated = (months: number) =>
    months >= schedule.depreciationMonths ? schedule.initialAsset : ore(monthly * months)
  return {
    payments: sum(inYear, (row) => row.payment),
    interestPaid: sum(inYear, (row) => row.interest),
    interestExpense,
    amortisation: sum(inYear, (row) => row.amortisation),
    depreciation: ore(accumulated(through) - accumulated(before)),
    closingLiability,
    dueWithinOneYear,
    accruedInterest,
    closingAsset: ore(schedule.initialAsset - accumulated(through)),
  }
}

/**
 * Interest accrued but not yet paid at the start of the financial year that
 * begins on `periodStart` (month-aligned): what 2960 holds for the lease
 * after the previous year-end adjustment.
 */
export function accruedInterestAt(lease: FinanceLease, schedule: LeaseSchedule, periodStart: string): number {
  const boundary = monthsBetween(lease.startDate, periodStart)
  return ore(schedule.rows
    .filter((row) => row.date >= periodStart)
    .reduce((total, row) => {
      const span = row.accrualToMonth - row.accrualFromMonth
      if (span <= 0) return total
      const overlap = Math.max(0, Math.min(row.accrualToMonth, boundary) - row.accrualFromMonth)
      return total + (row.interest * overlap) / span
    }, 0))
}

export interface LeaseAccounts {
  /** 1217 Finansiellt leasade maskiner or 1227 Finansiellt leasade inventarier. */
  asset: string
  /** The asset's accumulated depreciation (1219, 1229). */
  accumulatedDepreciation: string
  /** The lease liability; BAS has none of its own, so the company's (often 2399 Övriga långfristiga skulder). */
  liability: string
  /** 2960 Upplupna räntekostnader. */
  accruedInterest: string
  /** Where the year's payments were booked (5615 Leasing av personbilar, 5220 Hyra av inventarier ...). */
  leaseCost: string
  /** 8419 Övriga räntekostnader för långfristiga skulder, or the company's. */
  interest: string
  /** 7836 Avskrivningar på leasade tillgångar. */
  depreciation: string
}

export interface LeaseLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string
}

function signed(account: string, amount: number, text: string): LeaseLine | null {
  const value = ore(amount)
  if (value === 0) return null
  return value > 0
    ? { account_number: account, debit_amount: value, credit_amount: 0, line_description: text }
    : { account_number: account, debit_amount: 0, credit_amount: -value, line_description: text }
}

const present = (lines: Array<LeaseLine | null>) => lines.filter((line): line is LeaseLine => line !== null)

/** The asset and liability at the start (20.5); direct costs already paid move from their account onto the asset. */
export function initialRecognitionLines(
  lease: FinanceLease,
  schedule: LeaseSchedule,
  accounts: LeaseAccounts,
  directCostAccount: string,
): LeaseLine[] {
  return present([
    signed(accounts.asset, schedule.initialAsset, `Finansiellt leasingavtal ${lease.name}`),
    signed(accounts.liability, -schedule.initialLiability, `Leasingskuld ${lease.name}`),
    signed(directCostAccount, -lease.directCosts, `Direkta utgifter ${lease.name}`),
  ])
}

/**
 * The year-end adjustment: the payments booked as cost leave the lease cost
 * account and become amortisation and paid interest, the year's interest is
 * accrued against 2960 (the difference to the paid part), and the
 * depreciation is added. `openingAccruedInterest` is what 2960 held for the
 * lease at the start of the year. Balanced by construction.
 */
export function yearEndLines(
  lease: FinanceLease,
  year: LeaseYear,
  accounts: LeaseAccounts,
  openingAccruedInterest: number,
): LeaseLine[] {
  const accrualChange = ore(year.accruedInterest - openingAccruedInterest)
  return present([
    signed(accounts.leaseCost, -year.payments, `Leasingavgifter ${lease.name} till ränta och amortering`),
    signed(accounts.liability, year.amortisation, `Amortering leasingskuld ${lease.name}`),
    signed(accounts.interest, ore(year.interestPaid + accrualChange), `Ränta leasingskuld ${lease.name}`),
    signed(accounts.accruedInterest, -accrualChange, `Upplupen ränta leasingskuld ${lease.name}`),
    signed(accounts.depreciation, year.depreciation, `Avskrivning leasad tillgång ${lease.name}`),
    signed(accounts.accumulatedDepreciation, -year.depreciation, `Avskrivning leasad tillgång ${lease.name}`),
  ])
}
