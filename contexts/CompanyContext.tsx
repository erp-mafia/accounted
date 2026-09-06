'use client'

import { createContext, useContext } from 'react'
import type { Company, CompanyRole, Team } from '@/types'
import type { CapabilityKey } from '@/lib/entitlements/keys'
import type { EntitlementState } from '@/lib/entitlements/has-capability'
import type { MultiUserAccess } from '@/lib/entitlements/multi-user-state'

/** The user's byrå team membership (teams.kind = 'byra'), when any (WL-08). */
export interface ByraTeamRef {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
  /**
   * Where "Tillbaka till klienter" points: '/clients' when the current host
   * is the byrå cockpit's home domain, else an absolute URL to that home
   * (resolveCockpitHref). Optional: the no-company layout branch renders
   * before brands resolve and leaves it unset; consumers fall back to
   * '/clients', which on that branch's cockpit/settings surfaces matches the
   * pre-cockpitHref behavior exactly.
   */
  cockpitHref?: string
}

/**
 * A membership company homed on ANOTHER host (the home-domain rule, WL-01):
 * shown as a non-clickable "Hanteras via <domain>" signpost entry.
 */
export interface ForeignCompanyEntry {
  id: string
  name: string
  domain: string
}

interface CompanyContextValue {
  company: Company | null
  role: CompanyRole | null
  /**
   * Memberships homed on the CURRENT host (home-domain rule): the switcher
   * offers only these. Companies homed elsewhere are in foreignCompanies.
   */
  companies: { company: Company; role: CompanyRole }[]
  isTeamMember: boolean
  team: Team | null
  /** Byrå team membership; null for everyone outside a byrå (cockpit gate). */
  byraTeam?: ByraTeamRef | null
  /** Companies homed on another domain, for the "Hanteras via" section. */
  foreignCompanies?: ForeignCompanyEntry[]
  isSandbox: boolean
  /** PAID capability keys the active company currently holds (entitled + enabled). */
  capabilities: CapabilityKey[]
  /**
   * Whether this deployment can run the in-app assistant, i.e. the tool-loop
   * runtime behind /api/agent/invoke: getAiStatus().assistantAvailable, false
   * without AI credentials or on an OpenAI-compatible endpoint (#2204).
   * Deployment-level, not per company. Gates ONLY the surfaces that open
   * that runtime; provider-agnostic AI (the single-call ask console,
   * categorization, document extraction) never reads it. The route's 503
   * stays the real enforcement.
   */
  assistantAvailable: boolean
  /**
   * Trial expiry while the trial is the company's only source of paid access;
   * null when paying/comped or after the trial lapsed. Drives the countdown
   * touchpoint in the sidebar.
   */
  trialEndsAt: string | null
  /**
   * Paid-lifecycle state (trial / trial_expired / lapsed_subscription /
   * paid / none). 'none' in the company:null shells. Drives the expired-trial
   * touchpoint and dialog.
   */
  entitlementState: EntitlementState
  /** When the lapsed trial ran out; set only while entitlementState is 'trial_expired'. */
  trialExpiredAt: string | null
  /**
   * Multi-user seat state of the ACTIVE company (entitled / grace / frozen)
   * with the grace deadline. Optional: the no-company shells leave it unset;
   * consumers treat absence as entitled (UI affordance only, the server
   * enforces).
   */
  multiUser?: MultiUserAccess
  /**
   * Companies in `companies` that are FROZEN for this user (non-owner
   * membership, multi_user lapsed past grace): the switcher renders them
   * greyed with a lock instead of hiding them. Optional; absent = none.
   */
  lockedCompanyIds?: string[]
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

/**
 * Whether the deployment can run the in-app assistant (see
 * CompanyContextValue.assistantAvailable). Read it at every entry point that
 * opens AgentChat / /api/agent/invoke; the single-call console (general.help)
 * runs on any provider and does not need it. Fail-open outside a
 * CompanyProvider for the same reason as useCapability: the server answers 503.
 */
export function useAssistantAvailable(): boolean {
  const ctx = useContext(CompanyContext)
  if (!ctx) return true
  return ctx.assistantAvailable
}
