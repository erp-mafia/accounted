'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn, formatCurrency } from '@/lib/utils'
import { UpcomingDeadlinesWidget } from '@/components/deadlines/UpcomingDeadlinesWidget'
import { TaxTodoWidget } from '@/components/deadlines/TaxTodoWidget'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import {
  ChevronRight,
  CheckCircle2,
  ArrowRight,
  MessageCircle,
} from 'lucide-react'
import type { Deadline, OnboardingProgress } from '@/types'
import type { SuggestedMatch, WorklistCounts } from '@/lib/worklist/types'

const setupFreshStartKey = (companyId: string) => `erp_setup_fresh_start:${companyId}`

interface DashboardContentProps {
  companyId: string
  summary: {
    ytd: { income: number; expenses: number; net: number }
    mtd: { income: number; expenses: number; net: number }
    unpaidInvoicesCount: number
    unpaidInvoicesTotal: number
    unpaidVatTotal: number
    overdueInvoicesCount: number
    bankBalance: number | null
    expiringBankConnections?: { id: string; bank_name: string; days_left: number }[]
    deadlines: Deadline[]
    staleUncategorizedCount: number
  }
  /** Unified pending-work counts from lib/worklist — same source as the sidebar badges. */
  worklist: WorklistCounts
  /** High-confidence transaction↔invoice matches for inline one-click confirm. */
  suggestedMatches: SuggestedMatch[]
  onboardingProgress?: OnboardingProgress
  /**
   * False until the company has a verified agent_profile. When false the hero
   * slot shows a build-assistant prompt instead of the next-best-action card,
   * so existing/migrated users are nudged to build the assistant without a
   * full-screen onboarding takeover.
   */
  agentBuilt?: boolean
}

export default function DashboardContent({ companyId, summary, worklist, suggestedMatches, onboardingProgress, agentBuilt = true }: DashboardContentProps) {
  const t = useTranslations('dashboard')

  // The setup gate exists to nudge brand-new users into a data-import step
  // before they hit the dashboard. Once the assistant is built we treat the
  // user as past that phase — they've already committed to using the tool —
  // and let the dashboard render normally. This also keeps the sandbox
  // (which ships with a pre-built assistant + seeded data but no bank
  // connection / SIE import) from showing a checklist that re-links to
  // /onboarding/agent.
  const needsSetup =
    !agentBuilt &&
    onboardingProgress &&
    !onboardingProgress.hasBankConnected &&
    !onboardingProgress.hasSIEImport
  const [setupGateActive, setSetupGateActive] = useState(!!needsSetup)

  useEffect(() => {
    if (!needsSetup) {
      setSetupGateActive(false)
      return
    }
    const scopedKey = setupFreshStartKey(companyId)
    const freshStart = localStorage.getItem(scopedKey) === 'true'
    const legacyFreshStart = localStorage.getItem('erp_setup_fresh_start') === 'true'
    const legacyDismissed = localStorage.getItem('erp_checklist_dismissed') === 'true'
    if (freshStart || legacyFreshStart || legacyDismissed) {
      if (!freshStart) {
        localStorage.setItem(scopedKey, 'true')
      }
      setSetupGateActive(false)
    }
  }, [needsSetup, companyId])

  if (setupGateActive) {
    return (
      <NewUserChecklist
        hasBookkeepingImported={!!onboardingProgress?.hasSIEImport}
        hasBankConnected={!!onboardingProgress?.hasBankConnected}
        hasSkatteverketConnected={!!onboardingProgress?.hasSkatteverketConnected}
        hasAgentBuilt={agentBuilt}
        onFreshStart={() => {
          localStorage.setItem(setupFreshStartKey(companyId), 'true')
          setSetupGateActive(false)
        }}
      />
    )
  }

  const formatLargeNumber = (amount: number) => {
    return new Intl.NumberFormat('sv-SE', {
      style: 'decimal',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  }

  // One number, one source: the worklist total plus expiring bank connections
  // (dashboard-only, not a lib/worklist category). Must match AttGoraSection's
  // header so the tile and the section never disagree.
  const todoCount = worklist.total + (summary.expiringBankConnections?.length ?? 0)

  return (
    <div className="stagger-enter space-y-8">
      {/* Build-assistant hero — shown only until the company has a verified
          agent_profile, so existing/migrated users get a clear prompt instead
          of a full-screen onboarding takeover. Once the assistant is built the
          dashboard leads with the metrics + the unified "Att göra" worklist
          below; we deliberately drop a next-best-action hero here so the page
          has a single CTA surface instead of two that point at the same work. */}
      {!agentBuilt && (
        <section>
          <Link href="/onboarding/agent" className="block group">
            <Card className="transition-colors hover:border-primary/50">
              <CardContent className="p-6 flex items-center gap-4">
                <div className="flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center bg-foreground text-background">
                  <MessageCircle className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-display text-xl leading-tight">Bygg din bokföringsassistent</p>
                    <Badge variant="secondary" className="uppercase tracking-wider">Beta</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Några frågor om din verksamhet kalibrerar en assistent som föreslår bokföring åt dig.
                  </p>
                </div>
                <div className="hidden sm:flex items-center gap-1.5 text-sm font-medium text-foreground group-hover:translate-x-0.5 transition-transform">
                  <span>Kom igång</span>
                  <ArrowRight className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          </Link>
        </section>
      )}

      {/* Key metrics — 4 compact cards */}
      <section>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">{t('result')}</p>
              <p className={cn(
                'font-display text-xl tabular-nums leading-tight',
                summary.mtd.net >= 0 ? 'text-success' : 'text-destructive'
              )}>
                {formatLargeNumber(summary.mtd.net)}
                <span className="text-sm ml-0.5 text-muted-foreground font-normal">kr</span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {formatCurrency(summary.ytd.net)} {t('this_year_short')}
              </p>
            </CardContent>
          </Card>

          <Link href="/invoices?status=unpaid">
            <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer">
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <p className="text-xs text-muted-foreground mb-2">{t('to_be_paid')}</p>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                </div>
                <p className="font-display text-xl tabular-nums leading-tight">
                  {summary.unpaidInvoicesCount}
                  {t('units') && <span className="text-sm ml-0.5 text-muted-foreground font-normal">{t('units')}</span>}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatCurrency(summary.unpaidInvoicesTotal)}
                </p>
              </CardContent>
            </Card>
          </Link>

          {summary.bankBalance !== null ? (
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-2">{t('bank_balance')}</p>
                <p className="font-display text-xl tabular-nums leading-tight">
                  {formatLargeNumber(summary.bankBalance)}
                  <span className="text-sm ml-0.5 text-muted-foreground font-normal">kr</span>
                </p>
              </CardContent>
            </Card>
          ) : (
            <Link href="/import">
              <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <p className="text-xs text-muted-foreground mb-2">{t('bank_balance')}</p>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                  </div>
                  <p className="text-sm font-medium text-primary">{t('connect_bank')}</p>
                </CardContent>
              </Card>
            </Link>
          )}

          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">{t('todo')}</p>
              <div role="status" aria-live="polite">
                {todoCount > 0 ? (
                  <p className="font-display text-xl tabular-nums leading-tight">
                    {todoCount}
                    {t('units') && <span className="text-sm ml-0.5 text-muted-foreground font-normal">{t('units')}</span>}
                  </p>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <p className="text-sm font-medium text-success">{t('all_done')}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Att göra — the unified worklist. One section, every actionable item,
          same counts as the sidebar badges (lib/worklist). */}
      <AttGoraSection
        worklist={worklist}
        suggestedMatches={suggestedMatches}
        expiringBankConnections={summary.expiringBankConnections}
        staleUncategorizedCount={summary.staleUncategorizedCount}
      />

      {/* Result — revenue / expenses (always visible) */}
      <section>
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground mb-3">{t('revenue')}</p>
              <p className="font-display text-2xl tabular-nums leading-tight">
                {formatLargeNumber(summary.mtd.income)}
                <span className="text-base ml-1 text-muted-foreground font-normal">kr</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('this_month')}</p>
              <div className="mt-4 pt-3 border-t border-border flex items-baseline justify-between">
                <p className="text-xs text-muted-foreground">{t('this_year_block')}</p>
                <p className="text-sm font-medium tabular-nums">{formatCurrency(summary.ytd.income)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground mb-3">{t('expenses')}</p>
              <p className="font-display text-2xl tabular-nums leading-tight">
                {formatLargeNumber(summary.mtd.expenses)}
                <span className="text-base ml-1 text-muted-foreground font-normal">kr</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{t('this_month')}</p>
              <div className="mt-4 pt-3 border-t border-border flex items-baseline justify-between">
                <p className="text-xs text-muted-foreground">{t('this_year_block')}</p>
                <p className="text-sm font-medium tabular-nums">{formatCurrency(summary.ytd.expenses)}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Upcoming deadlines */}
      {summary.deadlines && summary.deadlines.length > 0 && (
        <section>
          <UpcomingDeadlinesWidget deadlines={summary.deadlines} maxItems={8} />
        </section>
      )}

      {/* Tax todo */}
      {summary.deadlines?.some(d => d.deadline_type === 'tax' && !d.is_completed) && (
        <section>
          <TaxTodoWidget deadlines={summary.deadlines} />
        </section>
      )}
    </div>
  )
}
