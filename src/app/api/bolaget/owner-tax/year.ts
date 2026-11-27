import { isFiscalYear } from '@/lib/invariants/fiscal-year'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { ownerTaxOpeningYear } from '@/lib/bolaget/filing-year'

/** An inkomstår from a path or query: four digits, 2000-2099. Null when malformed. */
export function parseIncomeYear(raw: string | null | undefined): number | null {
  if (!raw || !isFiscalYear(raw)) return null
  const year = Number(raw)
  return year >= 2000 && year <= 2099 ? year : null
}

/**
 * The ?year= of an owner tax read: when absent, the year the page opens on
 * (ownerTaxOpeningYear: last year in January, never a year without K10
 * underlag when an earlier one has it); null when malformed.
 */
export function readIncomeYear(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('year')
  if (raw === null || raw === '') return ownerTaxOpeningYear(todayIsoStockholm())
  return parseIncomeYear(raw)
}
