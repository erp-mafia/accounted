'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { ALL_YEARS_VALUE, STORAGE_KEY_PREFIX } from '@/components/common/fiscal-year-storage'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import {
  effectiveFiscalScope,
  prepareFiscalPeriods,
  resolveAppFiscalChoice,
  type EffectiveScopeOptions,
} from '@/lib/reference-data/fiscal-scope'
import type { FiscalPeriod } from '@/types'

interface FiscalScopeContextValue {
  /** The app-wide choice: a period id, or null for "Alla räkenskapsår". */
  choice: string | null
  /** Every period, newest first. */
  periods: FiscalPeriod[]
  /** The periods are loaded and the choice restored. */
  ready: boolean
  setChoice: (periodId: string | null) => void
}

const FiscalScopeContext = createContext<FiscalScopeContextValue | null>(null)

/**
 * The fiscal year as app-wide context (Stil v3, product decision
 * 2026-10-29): one choice beside the company name in the sidebar that every
 * page reads, instead of a year picker on each page. Persisted per company
 * under the same localStorage key the shared FyPicker scope used, so a
 * person's year carries over. Mounted once in the dashboard layout, inside
 * the reference-data seed (the period list is already cached there).
 */
export function FiscalScopeProvider({ children }: { children: ReactNode }) {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const { periods: cached, isLoading } = useFiscalPeriods()
  const periods = useMemo(() => prepareFiscalPeriods(cached, false), [cached])
  const [state, setState] = useState<{ companyId: string | null; choice: string | null; ready: boolean }>({
    companyId: null,
    choice: null,
    ready: false,
  })

  // Restore once per company, after its periods have loaded.
  useEffect(() => {
    if (!companyId || isLoading || state.companyId === companyId) return
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(STORAGE_KEY_PREFIX + companyId)
    } catch {
      // Storage blocked (private mode, a sandboxed frame): the default year.
    }
    setState({ companyId, choice: resolveAppFiscalChoice(periods, stored), ready: true })
  }, [companyId, isLoading, periods, state.companyId])

  // Another tab chose a year: follow it.
  useEffect(() => {
    if (!companyId) return
    const key = STORAGE_KEY_PREFIX + companyId
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return
      setState((s) => ({ ...s, choice: resolveAppFiscalChoice(periods, event.newValue) }))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [companyId, periods])

  const setChoice = useCallback(
    (periodId: string | null) => {
      if (!companyId) return
      try {
        window.localStorage.setItem(STORAGE_KEY_PREFIX + companyId, periodId ?? ALL_YEARS_VALUE)
      } catch {
        // Not persisted; the choice still holds for this tab.
      }
      setState({ companyId, choice: periodId, ready: true })
    },
    [companyId],
  )

  const ready = state.ready && state.companyId === companyId
  const value = useMemo<FiscalScopeContextValue>(
    () => ({ choice: ready ? state.choice : null, periods, ready, setChoice }),
    [ready, state.choice, periods, setChoice],
  )
  return <FiscalScopeContext.Provider value={value}>{children}</FiscalScopeContext.Provider>
}

export interface FiscalScope {
  /** The period this page shows, or null for all years (only where allowAll). */
  periodId: string | null
  period: FiscalPeriod | null
  /** Every period, newest first, for a page that lists them. */
  periods: FiscalPeriod[]
  /** False until the periods have loaded and the choice is restored: hold the first fetch. */
  ready: boolean
  /** Change the app-wide year (the sidebar does; a page rarely needs to). */
  setPeriodId: (periodId: string | null) => void
}

/**
 * The fiscal year a page shows: the app-wide choice under the page's own
 * constraints (effectiveFiscalScope). A report passes { allowAll: false,
 * hideFuture: true } and always gets one started year.
 */
export function useFiscalScope(options: EffectiveScopeOptions = {}): FiscalScope {
  const ctx = useContext(FiscalScopeContext)
  if (!ctx) throw new Error('useFiscalScope must be used inside FiscalScopeProvider')
  const { allowAll, hideFuture } = options
  const pick = useMemo(
    () => effectiveFiscalScope(ctx.periods, ctx.choice, { allowAll, hideFuture }),
    [ctx.periods, ctx.choice, allowAll, hideFuture],
  )
  return { ...pick, periods: ctx.periods, ready: ctx.ready, setPeriodId: ctx.setChoice }
}

/**
 * A page whose year lives in its URL (?period=, the year-end pages, which
 * are linked to per year): the deep link wins on arrival and the sidebar
 * follows it; a later pick in the sidebar moves the URL. With no year in the
 * URL the page takes the app-wide year into it. Returns the URL's period id,
 * the one the page fetches.
 */
export function useUrlFiscalPeriod(
  urlPeriodId: string | null,
  /** The page's path; the year goes in as ?period=<id>. */
  basePath: string,
  options: EffectiveScopeOptions = {},
): string | null {
  const router = useRouter()
  const { periodId, ready, setPeriodId } = useFiscalScope(options)
  // The URL year the sidebar was last aligned to.
  const adopted = useRef<string | null>(null)
  useEffect(() => {
    if (!ready) return
    if (urlPeriodId && adopted.current !== urlPeriodId) {
      // Arrival, or a link on the page to another year: the sidebar follows.
      adopted.current = urlPeriodId
      if (periodId !== urlPeriodId) setPeriodId(urlPeriodId)
      return
    }
    if (periodId && periodId !== urlPeriodId) {
      // No year in the URL yet, or the sidebar chose another one: the URL follows.
      adopted.current = periodId
      router.replace(`${basePath}?period=${encodeURIComponent(periodId)}`)
    }
  }, [ready, periodId, urlPeriodId, setPeriodId, router, basePath])
  return urlPeriodId
}

/** The raw app-wide choice and its setter, for the sidebar chip. */
export function useFiscalScopeChoice(): FiscalScopeContextValue {
  const ctx = useContext(FiscalScopeContext)
  if (!ctx) throw new Error('useFiscalScopeChoice must be used inside FiscalScopeProvider')
  return ctx
}
