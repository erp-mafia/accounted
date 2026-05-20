'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { cn, formatCurrency } from '@/lib/utils'
import { UpcomingDeadlinesWidget } from '@/components/deadlines/UpcomingDeadlinesWidget'
import { TaxTodoWidget } from '@/components/deadlines/TaxTodoWidget'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import {
  Receipt,
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Landmark,
  CheckCircle2,
  FileWarning,
  Clock,
  ArrowRight,
} from 'lucide-react'
import type { Deadline, ReceiptQueueSummary, OnboardingProgress } from '@/types'
import { getBranding } from '@/lib/branding/service'

const setupFreshStartKey = (companyId: string) => `erp_setup_fresh_start:${companyId}`

interface DashboardContentProps {
  companyId: string
  summary: {
    ytd: { income: number; expenses: number; net: number }
    mtd: { income: number; expenses: number; net: number }
    uncategorizedCount: number
    uncategorizedIncome: number
    uncategorizedExpenses: number
    unpaidInvoicesCount: number
    unpaidInvoicesTotal: number
    unpaidVatTotal: number
    overdueInvoicesCount: number
    bankBalance: number | null
    expiringBankConnections?: { id: string; bank_name: string; days_left: number }[]
    deadlines: Deadline[]
    receiptQueue: ReceiptQueueSummary | null
    missingUnderlagCount: number
    staleUncategorizedCount: number
  }
  onboardingProgress?: OnboardingProgress
}

export default function DashboardContent({ companyId, summary, onboardingProgress }: DashboardContentProps) {
  const [showAllAlerts, setShowAllAlerts] = useState(false)

  const needsSetup = onboardingProgress && !onboardingProgress.hasBankConnected && !onboardingProgress.hasSIEImport
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
        hasSkatteverketConnected={!!onboardingProgress?.hasSkatteverketConnected}
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

  const alertItems: React.ReactNode[] = []

  if (summary.overdueInvoicesCount > 0) {
    alertItems.push(
      <Link key="overdue" href="/invoices?status=unpaid" className="group">
        <Card className="h-full border-destructive/30 hover:bg-destructive/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Receipt className="h-4 w-4 text-destructive flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Förfallna fakturor</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {summary.overdueInvoicesCount} st
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  if (summary.unpaidInvoicesCount > 0 && summary.overdueInvoicesCount < summary.unpaidInvoicesCount) {
    alertItems.push(
      <Link key="unpaid" href="/invoices?status=unpaid" className="group">
        <Card className="h-full border-warning/30 hover:bg-warning/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Receipt className="h-4 w-4 text-warning-foreground flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Obetalda fakturor</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {summary.unpaidInvoicesCount - summary.overdueInvoicesCount} st · {formatCurrency(summary.unpaidInvoicesTotal)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  if (summary.uncategorizedCount > 0) {
    alertItems.push(
      <Link key="transactions" href="/transactions" className="group">
        <Card className="h-full border-warning/30 hover:bg-warning/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <ArrowLeftRight className="h-4 w-4 text-warning-foreground flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Transaktioner</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {summary.uncategorizedCount} obokförda
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  if (summary.missingUnderlagCount > 0) {
    alertItems.push(
      <Link key="missing-underlag" href="/bookkeeping?missingUnderlag=true" className="group">
        <Card className="h-full border-warning/30 hover:bg-warning/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <FileWarning className="h-4 w-4 text-warning-foreground flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Saknade underlag</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {summary.missingUnderlagCount} verifikationer utan underlag
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  if (summary.staleUncategorizedCount > 0) {
    alertItems.push(
      <Link key="stale-transactions" href="/transactions" className="group">
        <Card className="h-full border-destructive/30 hover:bg-destructive/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Clock className="h-4 w-4 text-destructive flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Gamla transaktioner</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {summary.staleUncategorizedCount} transaktioner äldre än 14 dagar saknar bokföring
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  if (summary.expiringBankConnections && summary.expiringBankConnections.length > 0) {
    const conn = summary.expiringBankConnections[0]
    alertItems.push(
      <Link key="bank-expiry" href="/settings/banking" className="group">
        <Card className="h-full border-warning/30 hover:bg-warning/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Landmark className="h-4 w-4 text-warning-foreground flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Banksamtycke löper ut</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {conn.bank_name} — {conn.days_left} {conn.days_left === 1 ? 'dag' : 'dagar'} kvar
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  const MAX_VISIBLE_ALERTS = 3
  const visibleAlerts = showAllAlerts ? alertItems : alertItems.slice(0, MAX_VISIBLE_ALERTS)
  const hasMoreAlerts = alertItems.length > MAX_VISIBLE_ALERTS

  const passedDeadlinesCount = summary.deadlines.filter(d => !d.is_completed && new Date(d.due_date) <= new Date()).length
  const pendingReceiptsCount = summary.receiptQueue
    ? summary.receiptQueue.pending_review_count + summary.receiptQueue.unmatched_receipts_count
    : 0
  const todoCount = summary.uncategorizedCount + summary.overdueInvoicesCount + pendingReceiptsCount + passedDeadlinesCount

  const slim = getBranding().navDensity === 'slim'

  // Pick the single most-urgent next action so the launchpad surfaces one
  // unambiguous CTA. Order matches the friction we actually want to remove
  // first: stale → overdue → uncategorized → unpaid → all clear.
  const nextBestAction = (() => {
    if (summary.staleUncategorizedCount > 0) {
      return {
        href: '/transactions',
        title: 'Gamla transaktioner väntar',
        body: `${summary.staleUncategorizedCount} transaktion${summary.staleUncategorizedCount === 1 ? '' : 'er'} äldre än 14 dagar saknar bokföring.`,
        cta: 'Bokför nu',
        tone: 'destructive' as const,
        icon: Clock,
      }
    }
    if (summary.overdueInvoicesCount > 0) {
      return {
        href: '/invoices?status=unpaid',
        title: 'Förfallna fakturor',
        body: `${summary.overdueInvoicesCount} st · ${formatCurrency(summary.unpaidInvoicesTotal)}`,
        cta: 'Gå till fakturor',
        tone: 'destructive' as const,
        icon: Receipt,
      }
    }
    if (summary.uncategorizedCount > 0) {
      return {
        href: '/transactions',
        title: 'Transaktioner att bokföra',
        body: `${summary.uncategorizedCount} obokförd${summary.uncategorizedCount === 1 ? '' : 'a'} transaktion${summary.uncategorizedCount === 1 ? '' : 'er'}.`,
        cta: 'Bokför nu',
        tone: 'primary' as const,
        icon: ArrowLeftRight,
      }
    }
    if (summary.unpaidInvoicesCount > 0) {
      return {
        href: '/invoices?status=unpaid',
        title: 'Obetalda fakturor',
        body: `${summary.unpaidInvoicesCount} st · ${formatCurrency(summary.unpaidInvoicesTotal)}`,
        cta: 'Visa fakturor',
        tone: 'primary' as const,
        icon: Receipt,
      }
    }
    return {
      href: '/invoices/new',
      title: 'Allt är ikapp',
      body: 'Inga obokförda transaktioner och inga obetalda fakturor. Skicka nästa faktura?',
      cta: 'Skapa faktura',
      tone: 'neutral' as const,
      icon: CheckCircle2,
    }
  })()

  return (
    <div className="stagger-enter space-y-8">
      {slim && (
        <>
          {/* Next best action — single hero card */}
          <section>
            <Link href={nextBestAction.href} className="block group">
              <Card className={cn(
                'transition-colors',
                nextBestAction.tone === 'destructive' && 'border-destructive/30 hover:bg-destructive/[0.03]',
                nextBestAction.tone === 'primary' && 'hover:border-primary/50',
                nextBestAction.tone === 'neutral' && 'hover:border-primary/30',
              )}>
                <CardContent className="p-6 flex items-center gap-5">
                  <div className={cn(
                    'flex-shrink-0 h-10 w-10 rounded-lg flex items-center justify-center',
                    nextBestAction.tone === 'destructive' && 'bg-destructive/10 text-destructive',
                    nextBestAction.tone === 'primary' && 'bg-secondary text-foreground',
                    nextBestAction.tone === 'neutral' && 'bg-secondary text-foreground',
                  )}>
                    <nextBestAction.icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-display text-xl leading-tight">{nextBestAction.title}</p>
                    <p className="text-sm text-muted-foreground mt-1">{nextBestAction.body}</p>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm font-medium text-foreground group-hover:translate-x-0.5 transition-transform">
                    <span>{nextBestAction.cta}</span>
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          </section>

        </>
      )}

      {/* Key metrics — 4 compact cards */}
      <section>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">Resultat</p>
              <p className={cn(
                'font-display text-xl font-medium tabular-nums leading-tight',
                summary.mtd.net >= 0 ? 'text-success' : 'text-destructive'
              )}>
                {formatLargeNumber(summary.mtd.net)}
                <span className="text-sm ml-0.5 text-muted-foreground font-normal">kr</span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {formatCurrency(summary.ytd.net)} i år
              </p>
            </CardContent>
          </Card>

          <Link href="/invoices?status=unpaid">
            <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer">
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <p className="text-xs text-muted-foreground mb-2">Att få betalt</p>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                </div>
                <p className="font-display text-xl font-medium tabular-nums leading-tight">
                  {summary.unpaidInvoicesCount}
                  <span className="text-sm ml-0.5 text-muted-foreground font-normal">st</span>
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
                <p className="text-xs text-muted-foreground mb-2">Banksaldo</p>
                <p className="font-display text-xl font-medium tabular-nums leading-tight">
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
                    <p className="text-xs text-muted-foreground mb-2">Banksaldo</p>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                  </div>
                  <p className="text-sm font-medium text-primary">Koppla bank</p>
                </CardContent>
              </Card>
            </Link>
          )}

          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">Att göra</p>
              <div role="status" aria-live="polite">
                {todoCount > 0 ? (
                  <p className="font-display text-xl font-medium tabular-nums leading-tight text-warning-foreground">
                    {todoCount}
                    <span className="text-sm ml-0.5 text-muted-foreground font-normal">st</span>
                  </p>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <p className="text-sm font-medium text-success">Allt klart!</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Resultat — intäkter / kostnader (always visible) */}
      <section>
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground mb-3">Intäkter</p>
              <p className="font-display text-2xl font-medium tabular-nums leading-tight">
                {formatLargeNumber(summary.mtd.income)}
                <span className="text-base ml-1 text-muted-foreground font-normal">kr</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">denna månad</p>
              <div className="mt-4 pt-3 border-t border-border/30 flex items-baseline justify-between">
                <p className="text-xs text-muted-foreground">I år</p>
                <p className="text-sm font-medium tabular-nums">{formatCurrency(summary.ytd.income)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <p className="text-sm text-muted-foreground mb-3">Kostnader</p>
              <p className="font-display text-2xl font-medium tabular-nums leading-tight">
                {formatLargeNumber(summary.mtd.expenses)}
                <span className="text-base ml-1 text-muted-foreground font-normal">kr</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">denna månad</p>
              <div className="mt-4 pt-3 border-t border-border/30 flex items-baseline justify-between">
                <p className="text-xs text-muted-foreground">I år</p>
                <p className="text-sm font-medium tabular-nums">{formatCurrency(summary.ytd.expenses)}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Att hantera — hidden in slim mode; the hero card already surfaces the top action */}
      {!slim && alertItems.length > 0 && (
        <section id="alerts-section">
          <h2 className="font-display text-lg font-medium mb-4">Att hantera</h2>
          <div id="alerts-list" className="grid gap-4 md:grid-cols-2">
            {visibleAlerts}
          </div>
          {hasMoreAlerts && (
            <button
              onClick={() => setShowAllAlerts(!showAllAlerts)}
              aria-expanded={showAllAlerts}
              aria-controls="alerts-list"
              className="mt-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              {showAllAlerts ? 'Visa färre' : `Visa alla (${alertItems.length})`}
              <ChevronDown className={cn('h-3 w-3 transition-transform', showAllAlerts && 'rotate-180')} />
            </button>
          )}
        </section>
      )}

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
