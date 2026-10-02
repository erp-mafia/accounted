import type { VatPeriodType } from '@/types'
import { codedError } from './company-routing'

/**
 * The (period_type, year, period) triple every VAT tool takes, checked before
 * anything reads the ledger or calls Skatteverket.
 *
 * Every VAT tool's inputSchema marks the three fields required and enumerates
 * period_type, but tools/call enforces neither (arg-guard rejects unknown
 * keys only). The Skatteverket tools cast whatever arrived, so a call without
 * `year` went to Skatteverket as redovisningsperiod "undefinedundefined":
 * 7 requests from 6 companies since 2026-07-26, each answered 400 and handed
 * to the agent as UNKNOWN_ERROR (feedback telemetry seq 804068, 809879).
 * The report tools did check, but with plain Errors (UNKNOWN_ERROR again),
 * and a missing monthly period slipped through as NaN.
 */
export interface VatPeriodArgs {
  periodType: VatPeriodType
  year: number
  period: number
}

const PERIOD_TYPES: readonly VatPeriodType[] = ['monthly', 'quarterly', 'yearly']
const EXAMPLE_CALL = '{"period_type":"quarterly","year":2026,"period":3}'
const MAX_PERIOD: Record<Exclude<VatPeriodType, 'yearly'>, number> = { monthly: 12, quarterly: 4 }

export function parseVatPeriodArgs(args: Record<string, unknown>): VatPeriodArgs {
  const periodType = args.period_type
  if (typeof periodType !== 'string' || !(PERIOD_TYPES as readonly string[]).includes(periodType)) {
    throw invalid(`period_type must be one of monthly, quarterly, yearly (got ${describe(periodType)})`)
  }
  const year = wholeNumber(args.year)
  if (year === null || year < 2000 || year > 2100) {
    throw invalid(`year must be between 2000 and 2100, as a whole year (got ${describe(args.year)})`)
  }
  if (periodType === 'yearly') {
    // Helårsmoms has one period per year, resolved from the räkenskapsår that
    // ends in `year`; the period number carries nothing, so it is not demanded.
    return { periodType, year, period: 1 }
  }
  const type = periodType as Exclude<VatPeriodType, 'yearly'>
  const period = wholeNumber(args.period)
  if (period === null || period < 1 || period > MAX_PERIOD[type]) {
    throw invalid(
      `period must be 1-${MAX_PERIOD[type]} for period_type=${type} (got ${describe(args.period)})`,
    )
  }
  return { periodType: type, year, period }
}

function wholeNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isInteger(n) ? n : null
}

function describe(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

function invalid(reason: string): Error {
  return codedError('VALIDATION_ERROR', `${reason}. A working call looks like: ${EXAMPLE_CALL}`)
}
