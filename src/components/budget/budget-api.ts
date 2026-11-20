/**
 * The /budget page's calls to its dashboard routes (app/api/budgets/**).
 * Every failure is read through getErrorMessage, so a refusal reaches the
 * user in their language with the route's own reason.
 */
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

export type BudgetCallResult<T> = { ok: true; data: T } | { ok: false; message: string }

export async function budgetCall<T>(
  url: string,
  init: RequestInit & { json?: unknown },
  locale: ErrorLocale,
): Promise<BudgetCallResult<T>> {
  const { json, ...rest } = init
  try {
    const res = await fetch(url, {
      ...rest,
      ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } } : {}),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, message: getErrorMessage(body, { statusCode: res.status, locale }) }
    return { ok: true, data: (body as { data: T }).data }
  } catch (error) {
    return { ok: false, message: getErrorMessage(error, { locale }) }
  }
}

export interface BudgetSummary {
  budget_id: string
  fiscal_period_id: string
  name: string
  is_default: boolean
  archived: boolean
}

export interface BudgetGridData {
  budget: BudgetSummary
  fiscal_period: { fiscal_period_id: string; name: string; period_start: string; period_end: string }
  months: string[]
  mode: 'untagged' | 'tag' | 'sum'
  dimensions: Record<string, string> | null
  editable: boolean
  has_tagged_lines: boolean
  rows: { account_number: string; account_name: string | null; amounts: number[] }[]
}

/** Counts every write answers (upsert_budget_lines). */
export interface BudgetSaveCounts {
  inserted: number
  updated: number
  deleted: number
  unchanged: number
}
