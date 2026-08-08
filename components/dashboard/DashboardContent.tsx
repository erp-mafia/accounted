'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { AttnLine } from '@/components/ui/attn-line'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useCapability, useCompany } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import ResumePane from '@/components/dashboard/ResumePane'
import BackupHealthBanner from '@/components/dashboard/BackupHealthBanner'
import { SkatteverketPromoCard } from '@/components/dashboard/SkatteverketPromoCard'
import { ArrowRight } from 'lucide-react'
import type { InitialSetupState, OnboardingProgress } from '@/types'
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
   * True when this account looks bookkeeping-empty while a same-orgnr
   * company with real bookkeeping exists in another account (#1231): the
   * user probably signed in with the wrong login (stale BankID account).
   */
  otherAccountHint?: boolean
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
  otherAccountHint = false,
  onboardingProgress,
  initialSetup,
  agentBuilt = true,
  vatLine = null,
  emptyLedger = false,
}: DashboardContentProps) {
  const t = useTranslations('dashboard')
  const hasAi = useCapability(CAPABILITY.ai)
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
      <BackupHealthBanner />

      {/* Greeting hero (concept scene 14) */}
      <section>
        <h1 className="font-display text-2xl leading-8 tracking-tight">
          {userFirstName ? `${greeting}, ${userFirstName}.` : `${greeting}.`}
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {dateLine}
          {company?.name ? ` · ${company.name}` : ''}
        </p>
        {otherAccountHint && (
          <AttnLine
            className="mt-3"
            action={{ label: t('other_account_hint_action'), onClick: handleSwitchAccount }}
          >
            {t('other_account_hint')}
          </AttnLine>
        )}
      </section>

      <NewUserChecklist
        initialState={initialSetup}
        hasBookkeepingImported={!!onboardingProgress?.hasSIEImport}
        hasBankConnected={!!onboardingProgress?.hasBankConnected}
        hasSkatteverketConnected={!!onboardingProgress?.hasSkatteverketConnected}
        hasInboxItems={!!onboardingProgress?.hasInboxItems}
        hasAgentBuilt={agentBuilt}
        vatLine={vatLine}
      />

      {/* Build-assistant hero: shown only until the company has a verified
          agent_profile, so existing/migrated users get a clear prompt instead
          of a full-screen onboarding takeover. While the stepped first-run
          checklist is visible it already carries the assistant as its last
          step, so the hero waits until that block is dismissed or completed. */}
      {!agentBuilt && (initialSetup.dismissedAt || initialSetup.completedAt) && (
        <section>
          {/* Non-payers keep seeing the hero (conversion surface) but it
              routes to billing instead of a build flow that would 403. */}
          <Link href={hasAi ? '/onboarding/agent' : '/settings/billing'} className="block group">
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-display text-xl leading-tight">Bygg din bokföringsassistent</p>
                    <Badge variant="secondary" className="uppercase tracking-wider">Beta</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {hasAi
                      ? 'Några frågor om din verksamhet kalibrerar en assistent som föreslår bokföring åt dig.'
                      : 'Ingår i abonnemanget: en assistent som föreslår bokföring åt dig.'}
                  </p>
                </div>
                <div className="hidden sm:flex items-center gap-1.5 text-sm font-medium text-foreground group-hover:translate-x-0.5 transition-transform">
                  <span>{hasAi ? 'Kom igång' : 'Uppgradera'}</span>
                  <ArrowRight className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          </Link>
        </section>
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
