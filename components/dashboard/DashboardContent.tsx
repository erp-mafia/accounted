'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { SkatteverketPromoCard } from '@/components/dashboard/SkatteverketPromoCard'
import { AgentPromo } from '@/components/dashboard/AgentPromo'
import type { InitialSetupState } from '@/types'

interface DashboardContentProps {
  companyId: string
  /** Signed-in user's first name for the greeting; null falls back to a
   *  nameless greeting. */
  userFirstName?: string | null
  initialSetup: InitialSetupState
  /**
   * False until the company has a verified agent_profile. When false the hero
   * slot shows a build-assistant prompt instead of the next-best-action card,
   * so existing/migrated users are nudged to build the assistant without a
   * full-screen onboarding takeover.
   */
  agentBuilt?: boolean
  hasSkatteverketConnected?: boolean
  /**
   * Streamed sections (server components behind Suspense in
   * app/(dashboard)/page.tsx): the notice line, the setup checklist and the
   * Att göra + Fortsätt panes. The shell renders the greeting immediately
   * and each slot fills in as its queries resolve, instead of the whole page
   * waiting for the slowest of ~30 queries.
   */
  notices: ReactNode
  checklist: ReactNode
  panes: ReactNode
}

/**
 * Hem (concept scene 14): greeting, then the two panes side by side:
 * Att göra (obligations, lib/worklist) and Fortsätt (in-progress work,
 * lib/worklist/resume). KPI tiles, revenue/expense cards and the deadline/tax
 * widgets left the page (founder direction, dev_docs/last_session_resume.md
 * §8): the numbers live at /kpi and /reports, deadlines render as Bevaka rows.
 */
export default function DashboardContent({
  companyId,
  userFirstName,
  initialSetup,
  agentBuilt = true,
  hasSkatteverketConnected = false,
  notices,
  checklist,
  panes,
}: DashboardContentProps) {
  const t = useTranslations('dashboard')
  const { company } = useCompany()

  // Time-of-day greeting (concept: "God morgon, Jakob."). Client-side clock
  // on purpose (the user's local morning, not the server's), captured once
  // so render stays pure.
  const [greetingNow] = useState(() => new Date())
  const hour = greetingNow.getHours()
  const greeting =
    hour < 10 ? t('greeting_morning') : hour < 17 ? t('greeting_day') : t('greeting_evening')
  const dateLine = new Intl.DateTimeFormat('sv-SE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(greetingNow)

  return (
    <div className="stagger-enter space-y-8">
      {/* Degraded-state notices (lib/notices): one attn line, highest
          priority first, quiet "+N till" expander. The wrong-account hint
          participates in the same priority list instead of rendering its own
          unconditional line, and the old boxed BackupHealthBanner card lives
          on as the backup_failing category. */}
      {notices}

      {/* Greeting hero (concept scene 14) */}
      <section>
        <h1 className="font-display text-2xl leading-8 tracking-tight">
          {userFirstName ? `${greeting}, ${userFirstName}.` : `${greeting}.`}
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {dateLine}
          {company?.name ? ` · ${company.name}` : ''}
        </p>
      </section>

      {checklist}

      {/* Build-assistant nudge: shown only until the company has a verified
          agent_profile, so existing/migrated users get a clear prompt instead
          of a full-screen onboarding takeover. While the stepped first-run
          checklist is visible it already carries the assistant as its last
          step, so the promo waits until that block is dismissed or completed. */}
      {!agentBuilt && (initialSetup.dismissedAt || initialSetup.completedAt) && (
        <AgentPromo companyId={companyId} />
      )}

      {/* The two panes (concept hem-grid). When nothing is in progress the
          right pane renders null and Att göra takes the full width. */}
      {panes}

      {/* Connect-Skatteverket nudge for existing companies. Gated on
          agentBuilt so it never stacks under the build-assistant hero:
          one CTA surface at a time. */}
      {agentBuilt && (
        <SkatteverketPromoCard companyId={companyId} connected={hasSkatteverketConnected} />
      )}
    </div>
  )
}
