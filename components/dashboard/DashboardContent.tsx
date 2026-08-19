'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import ResumePane from '@/components/dashboard/ResumePane'
import NoticeLines from '@/components/dashboard/NoticeLines'
import { SkatteverketPromoCard } from '@/components/dashboard/SkatteverketPromoCard'
import { AgentPromo } from '@/components/dashboard/AgentPromo'
import type { InitialSetupState, OnboardingProgress } from '@/types'
import type { Notice } from '@/lib/notices/types'
import type { SuggestedMatch, WorklistCounts } from '@/lib/worklist/types'
import type { ResumeItem } from '@/lib/worklist/resume'
import type { VatDeadlineLine } from '@/lib/onboarding/checklist'

interface DashboardContentProps {
  companyId: string
  /** Signed-in user's first name for the greeting; null falls back to a
   *  nameless greeting. */
  userFirstName?: string | null
  /** Expiring PSD2 consents (dashboard-only worklist extra). */
  expiringBankConnections?: { id: string; bank_name: string; days_left: number }[]
  /** Unified pending-work counts from lib/worklist: same source as the sidebar badges. */
  worklist: WorklistCounts
  /** High-confidence transaction↔invoice matches for inline one-click confirm. */
  suggestedMatches: SuggestedMatch[]
  /** In-progress work for the Fortsätt pane (lib/worklist/resume). */
  resumeItems: ResumeItem[]
  /**
   * Active degraded-state notices in priority order (lib/notices): broken or
   * expiring bank connections, Skatteverket reconnect, failing backups, the
   * wrong-account hint. Rendered as ONE attn line at the top with a quiet
   * "+N till" expander: never a stack of banners.
   */
  notices?: Notice[]
  onboardingProgress?: OnboardingProgress
  initialSetup: InitialSetupState
  /**
   * False until the company has a verified agent_profile. When false the hero
   * slot shows a build-assistant prompt instead of the next-best-action card,
   * so existing/migrated users are nudged to build the assistant without a
   * full-screen onboarding takeover.
   */
  agentBuilt?: boolean
  /** Personalized VAT-deadline line for the checklist's Skatteverket step. */
  vatLine?: VatDeadlineLine
  /**
   * True while the setup checklist is still open and the company has zero
   * posted journal entries: Att göra's all-clear then reads as "empty, get
   * started" instead of a false "all caught up".
   */
  emptyLedger?: boolean
  /** Latest SIE reconciliation-sweep outcome, for the checklist's bank step
   *  ("X matchade, Y att granska"). Null when no sweep has run. */
  sieSweep?: { auto_linked: number; suggested: number; unmatched: number; errors: number } | null
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
  expiringBankConnections,
  worklist,
  suggestedMatches,
  resumeItems,
  notices = [],
  onboardingProgress,
  initialSetup,
  agentBuilt = true,
  vatLine = null,
  emptyLedger = false,
  sieSweep = null,
}: DashboardContentProps) {
  const t = useTranslations('dashboard')
  const { company } = useCompany()
  const router = useRouter()

  // Wrong-account hint action: sign out so the user can come back in with
  // their other login (email+password). Same flow as SandboxBanner.
  async function handleSwitchAccount() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

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
      <NoticeLines
        notices={notices}
        actionOverrides={{ other_account_hint: handleSwitchAccount }}
      />

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

      <NewUserChecklist
        initialState={initialSetup}
        hasBookkeepingImported={!!onboardingProgress?.hasSIEImport}
        hasBankConnected={!!onboardingProgress?.hasBankConnected}
        hasSkatteverketConnected={!!onboardingProgress?.hasSkatteverketConnected}
        hasInboxItems={!!onboardingProgress?.hasInboxItems}
        hasAgentBuilt={agentBuilt}
        vatLine={vatLine}
        sieSweep={sieSweep}
      />

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
      <div
        className={
          resumeItems.length > 0 ? 'grid items-start gap-x-6 gap-y-8 md:grid-cols-2' : undefined
        }
      >
        <AttGoraSection
          worklist={worklist}
          suggestedMatches={suggestedMatches}
          expiringBankConnections={expiringBankConnections}
          emptyLedger={emptyLedger}
        />
        <ResumePane items={resumeItems} />
      </div>

      {/* Connect-Skatteverket nudge for existing companies. Gated on
          agentBuilt so it never stacks under the build-assistant hero:
          one CTA surface at a time. */}
      {agentBuilt && (
        <SkatteverketPromoCard
          companyId={companyId}
          connected={!!onboardingProgress?.hasSkatteverketConnected}
        />
      )}
    </div>
  )
}
