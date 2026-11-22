'use client'

import { createContext, useContext } from 'react'
import type { Company, CompanyRole, Team } from '@/types'
import { CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import type { EntitlementState } from '@/lib/entitlements/has-capability'

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
   * Whether the built-in assistant chat is switched on in this installation
   * (ASSISTANT_CHAT_ENABLED, lib/env/assistant-chat-switch.ts), as the layout
   * read it. Absent reads as on: the chat is there until someone switches it
   * off. Gates the doors into the chat only (the pages' "ask the assistant"
   * buttons, the palette's question row, the floating button's setting, the
   * panel coming back after a reload; the layout leaves out the floating
   * button itself). The routes' ASSISTANT_CHAT_OFF answer stays the real
   * enforcement.
   */
  assistantChatEnabled?: boolean
  /**
   * The last day a company that keeps the built-in chat has it
   * (ASSISTANT_CHAT_UNTIL, YYYY-MM-DD), as the layout read it; null or absent
   * when no day is set. The chat's own notice names it.
   */
  assistantChatUntil?: string | null
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
   * Companies in `companies` that are FROZEN for this user (non-owner
   * membership, multi_user lapsed past grace): the switcher renders them
   * greyed with a lock instead of hiding them. Optional; absent = none.
   */
  lockedCompanyIds?: string[]
  /**
   * Where "Lägg till företag" leads for this user (addCompanyHref): the
   * journey when the BankID picker would be empty. Optional; absent = the
   * picker door, which redirects on its own.
   */
  addCompanyHref?: string
  /**
   * Whether the support dialog offers the AI assistant for this company and
   * user (lib/agent/support/rollout.ts: SUPPORT_ASSISTANT_COMPANY_IDS, an AI
   * backend configured, never the invoicing-only role or the sandbox), as the
   * layout read it. Absent reads as no: the dialog is then the form to a
   * person, as it was. POST /api/support/ask stays the real enforcement.
   */
  supportAssistant?: boolean
  /**
   * Whether manual booking opens the booking screen (/bokfor) instead of the
   * booking dialogs, as the layout read BOOKING_SCREEN_COMPANY_IDS
   * (lib/env/booking-screen-switch.ts). Absent reads as no: the dialogs stay.
   */
  bookingScreen?: boolean
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

/**
 * Whether manual booking opens the booking screen for the active company.
 * Off outside a CompanyProvider and while the layout did not say on.
 */
export function useBookingScreenEnabled(): boolean {
  return useContext(CompanyContext)?.bookingScreen === true
}

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
 * Whether POST /api/agent/categorize can answer for the active company. The
 * route refuses a sandbox company and one without the AI capability, and its
 * callers hide the refusal, so asking anyway only spends a request: 480 of
 * them from many companies in the week to 2026-11-12, nearly all on an expired
 * trial. Fail-open outside a CompanyProvider, like useCapability.
 */
export function useAssistantReadsAvailable(): boolean {
  const ctx = useContext(CompanyContext)
  if (!ctx) return true
  return !ctx.isSandbox && ctx.capabilities.includes(CAPABILITY.ai)
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

/**
 * Whether the built-in assistant chat is switched on (see
 * CompanyContextValue.assistantChatEnabled). Read it at every door that opens
 * the chat for a person, beside useAssistantAvailable where the door opens
 * the tool-loop runtime. On unless the layout said off, so also outside a
 * CompanyProvider: the server answers ASSISTANT_CHAT_OFF.
 */
export function useAssistantChatEnabled(): boolean {
  const ctx = useContext(CompanyContext)
  return ctx?.assistantChatEnabled !== false
}
