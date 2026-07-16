'use client'

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  type ReactNode,
} from 'react'
import useSWR from 'swr'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import type { CompanySettings } from '@/types'

export interface SettingsState {
  settings: CompanySettings | null
  /** True while the fetch for the active company is in flight. */
  isLoading: boolean
  /** True once a fetch finished without a row (or errored): distinct from loading. */
  error: boolean
  updateSettings: (updates: Partial<CompanySettings>) => void
  refetch: () => Promise<void>
}

/**
 * Standalone settings fetcher: loads `company_settings` for the active company
 * (resolved from CompanyContext). Use this OUTSIDE the settings surface (e.g. the
 * reports VAT view). Inside the settings surface, read the shared instance with
 * `useSettings()` instead: `SettingsProvider` mounts exactly one of these so
 * switching sections reuses the loaded data rather than refetching.
 *
 * Auth is already enforced by middleware before any authenticated page renders,
 * so this no longer round-trips `auth.getUser()`: it gates purely on the
 * resolved company id, removing a request from the path the skeleton waits on.
 */
export function useCompanySettings(): SettingsState {
  const { company } = useCompany()
  const companyId = company?.id ?? null

  // SWR-backed: every consumer of the same company's settings shares one
  // cache entry, so concurrent mounts dedupe into a single request and
  // back-navigation renders from cache (revalidating in the background)
  // instead of re-showing a skeleton. Null key = no active company (the
  // no-company escape hatch): a settled empty state, never a spinner.
  const { data, error: swrError, isLoading, mutate } = useSWR(
    companyId ? ['company_settings', companyId] : null,
    async ([, id]: [string, string]) => {
      const supabase = createClient()
      // maybeSingle() so a missing row resolves to { data: null } instead of
      // throwing PGRST116: a company created outside the onboarding flow may
      // have no company_settings row yet, and that must not be treated as a
      // hard error mid-query (it's surfaced as `error` below once settled).
      const { data, error: queryError } = await supabase
        .from('company_settings')
        .select('*')
        .eq('company_id', id)
        .maybeSingle()
      if (queryError) throw queryError
      return data as CompanySettings | null
    },
  )

  const updateSettings = useCallback(
    (updates: Partial<CompanySettings>) => {
      // Optimistic local patch only: callers persist through their own API
      // routes. revalidate: false so the patch isn't immediately overwritten
      // by a refetch racing the server-side write.
      void mutate((prev) => (prev ? ({ ...prev, ...updates } as CompanySettings) : prev), {
        revalidate: false,
      })
    },
    [mutate],
  )

  const refetch = useCallback(async () => {
    await mutate()
  }, [mutate])

  return {
    settings: data ?? null,
    isLoading: companyId ? isLoading : false,
    // Same contract as before SWR: error means "settled without a row"
    // (query failure or missing company_settings row), never mid-flight.
    error: companyId ? !isLoading && (Boolean(swrError) || !data) : false,
    updateSettings,
    refetch,
  }
}

const SettingsContext = createContext<SettingsState | null>(null)

/**
 * Hosts one shared settings fetch for the whole settings surface. Mounted once by
 * `SettingsShell`, it survives section swaps (the shell re-renders rather than
 * remounting when the active section changes), so moving between settings tabs
 * reuses the loaded data instead of refetching and re-flashing the skeleton.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const value = useCompanySettings()
  return createElement(SettingsContext.Provider, { value }, children)
}

/**
 * Read the shared settings instance. Must be rendered within a `SettingsProvider`
 * (every settings section is, via `SettingsShell`). Outside the settings surface,
 * use `useCompanySettings()` instead.
 */
export function useSettings(): SettingsState {
  const ctx = useContext(SettingsContext)
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return ctx
}
