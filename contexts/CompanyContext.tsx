'use client'

import { createContext, useContext } from 'react'
import type { Company, CompanyRole, Team } from '@/types'
import type { CapabilityKey } from '@/lib/entitlements/keys'

interface CompanyContextValue {
  company: Company | null
  role: CompanyRole | null
  companies: { company: Company; role: CompanyRole }[]
  isTeamMember: boolean
  team: Team | null
  isSandbox: boolean
  /** PAID capability keys the active company currently holds (entitled + enabled). */
  capabilities: CapabilityKey[]
  /**
   * Trial expiry while the trial is the company's only source of paid access;
   * null when paying/comped or after the trial lapsed. Drives the countdown
   * touchpoint in the sidebar.
   */
  trialEndsAt: string | null
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

export function CompanyProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: CompanyContextValue
}) {
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}

export function useCompanyOptional() {
  return useContext(CompanyContext)
}

/**
 * Whether the active company holds a given paid capability. Controls UI
 * affordances only: the server gate (lib/entitlements) is the real enforcement.
 * Fail-open when rendered outside a CompanyProvider (e.g. standalone dialogs):
 * the server still blocks; this only decides whether to show/disable/upsell.
 */
export function useCapability(key: CapabilityKey): boolean {
  const ctx = useContext(CompanyContext)
  if (!ctx) return true
  return ctx.capabilities.includes(key)
}
