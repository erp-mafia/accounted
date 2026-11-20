import { isFiscalYear } from '@/lib/invariants/fiscal-year'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** An inkomstår from a path or query: four digits, 2000-2099. Null when malformed. */
export function parseIncomeYear(raw: string | null | undefined): number | null {
  if (!raw || !isFiscalYear(raw)) return null
  const year = Number(raw)
  return year >= 2000 && year <= 2099 ? year : null
}

/** The ?year= of an owner tax read: the current year when absent, null when malformed. */
export function readIncomeYear(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('year')
  if (raw === null || raw === '') return Number(todayIsoStockholm().slice(0, 4))
  return parseIncomeYear(raw)
}
