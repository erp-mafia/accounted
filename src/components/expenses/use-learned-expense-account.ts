'use client'

import { useEffect, useState } from 'react'
import { learnedExpenseAccount, type ExpenseAccountHistoryRow, type LearnedExpenseAccount } from '@/lib/expenses/learned-account'
import { templateCostAccount, type CounterpartyTemplateMatch } from '@/lib/inkorg/owner-paid'

/**
 * What the company booked this merchant on before (lib/expenses/learned-account.ts), read while the utlägg
 * dialog is open for it: the counterparty template through the same lookup "Privat, med mina egna pengar" uses
 * (GET /api/settings/counterparty-templates?counterparty=), and the company's claims (GET /api/expense-claims).
 * Best effort: a read that fails counts as nothing learned, and the field stays for the person to pick. Null
 * while unknown or when nothing was learned.
 */
export function useLearnedExpenseAccount(merchant: string | null, chart: ReadonlySet<string>): LearnedExpenseAccount | null {
  const [answer, setAnswer] = useState<{
    merchant: string
    templateAccount: string | null
    claims: ExpenseAccountHistoryRow[]
  } | null>(null)

  useEffect(() => {
    if (!merchant) return
    const controller = new AbortController()
    const readJson = (url: string) =>
      fetch(url, { signal: controller.signal })
        .then(async (res) => (res.ok ? ((await res.json()) as { data?: unknown }).data : null))
        .catch(() => null)
    void Promise.all([
      readJson(`/api/settings/counterparty-templates?counterparty=${encodeURIComponent(merchant)}`),
      readJson('/api/expense-claims'),
    ]).then(([template, claims]) => {
      if (controller.signal.aborted) return
      setAnswer({
        merchant,
        templateAccount: templateCostAccount((template ?? null) as CounterpartyTemplateMatch | null),
        claims: Array.isArray(claims) ? (claims as ExpenseAccountHistoryRow[]) : [],
      })
    })
    return () => controller.abort()
  }, [merchant])

  if (!merchant || answer?.merchant !== merchant) return null
  return learnedExpenseAccount({ templateAccount: answer.templateAccount, merchant, claims: answer.claims, chart })
}
