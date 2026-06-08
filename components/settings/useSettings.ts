'use client'

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import type { CompanySettings } from '@/types'

export interface SettingsState {
  settings: CompanySettings | null
  /** True while the fetch for the active company is in flight. */
  isLoading: boolean
  /** True once a fetch finished without a row (or errored) — distinct from loading. */
  error: boolean
  updateSettings: (updates: Partial<CompanySettings>) => void
  refetch: () => Promise<void>
}

/**
 * Standalone settings fetcher: loads `company_settings` for the active company
 * (resolved from CompanyContext). Use this OUTSIDE the settings surface (e.g. the
 * reports VAT view). Inside the settings surface, read the shared instance with
 * `useSettings()` instead — `SettingsProvider` mounts exactly one of these so
 * switching sections reuses the loaded data rather than refetching.
 *
 * Auth is already enforced by middleware before any authenticated page renders,
 * so this no longer round-trips `auth.getUser()` — it gates purely on the
 * resolved company id, removing a request from the path the skeleton waits on.
 */
export function useCompanySettings(): SettingsState {
  const { company } = useCompany()
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchSettings = useCallback(async () => {
    if (!company?.id) {
      // No active company (the no-company escape hatch). Nothing to load; surface
      // a settled empty state rather than a perpetual spinner.
      setSettings(null)
      setError(false)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(false)

    const supabase = createClient()
    // maybeSingle() so a missing row resolves to { data: null } instead of
    // throwing PGRST116 — a company created outside the onboarding flow may have
    // no company_settings row yet, and that must not be treated as a hard error
    // mid-query (it's surfaced as `error` below once the fetch settles).
    const { data, error: queryError } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', company.id)
      .maybeSingle()

    setSettings(data)
    setError(Boolean(queryError) || !data)
    setIsLoading(false)
  }, [company?.id])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const updateSettings = useCallback((updates: Partial<CompanySettings>) => {
    setSettings((prev) => (prev ? ({ ...prev, ...updates } as CompanySettings) : prev))
  }, [])

  return { settings, isLoading, error, updateSettings, refetch: fetchSettings }
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
