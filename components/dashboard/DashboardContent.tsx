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
  Camera,
  Users,
  Landmark,
  CheckCircle2,
  FileWarning,
  Clock,
} from 'lucide-react'
import { getAllExtensions } from '@/lib/extensions/sectors'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { useCompany } from '@/contexts/CompanyContext'
import type { QuickActionDefinition } from '@/lib/extensions/types'
import type { CompanySettings, Deadline, ReceiptQueueSummary, OnboardingProgress } from '@/types'

const SETUP_FRESH_START_KEY = 'erp_setup_fresh_start'

interface DashboardContentProps {
  firstName?: string | null
  settings: CompanySettings | null
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

export default function DashboardContent({ firstName, settings, summary, onboardingProgress }: DashboardContentProps) {
  const { isTeamMember } = useCompany()
  const [showAllAlerts, setShowAllAlerts] = useState(false)
  const [showMore, setShowMore] = useState(false)

  // Setup gate — blocks dashboard until user imports data or chooses fresh start
  // Consultants (team members) skip this — they go straight to the dashboard
  const needsSetup = !isTeamMember && onboardingProgress && !onboardingProgress.hasBankConnected && !onboardingProgress.hasSIEImport
  const [setupGateActive, setSetupGateActive] = useState(!!needsSetup)

  useEffect(() => {
    if (!needsSetup) {
      setSetupGateActive(false)
      return
    }
    const freshStart = localStorage.getItem(SETUP_FRESH_START_KEY) === 'true'
    const oldDismissed = localStorage.getItem('erp_checklist_dismissed') === 'true'
    if (freshStart || oldDismissed) setSetupGateActive(false)
  }, [needsSetup])

  if (setupGateActive) {
    return (
      <NewUserChecklist
        onFreshStart={() => {
          localStorage.setItem(SETUP_FRESH_START_KEY, 'true')
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

  // Build alert items for "Att hantera" section
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

  if (summary.receiptQueue && (summary.receiptQueue.pending_review_count > 0 || summary.receiptQueue.unmatched_receipts_count > 0)) {
    alertItems.push(
      <Link key="receipts" href="/receipts" className="group">
        <Card className="h-full border-primary/30 hover:bg-primary/[0.03] transition-colors">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Camera className="h-4 w-4 text-primary flex-shrink-0" />
              <div>
                <p className="font-medium text-sm">Kvitton</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {summary.receiptQueue.pending_review_count > 0
                    ? `${summary.receiptQueue.pending_review_count} att granska`
                    : `${summary.receiptQueue.unmatched_receipts_count} omatchade`}
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

  // Build extension quick actions from all compiled extensions
  const extensionQuickActions: (QuickActionDefinition & { key: string })[] = getAllExtensions()
    .filter(def => def.quickAction)
    .map(def => ({ ...def.quickAction!, key: `${def.sector}/${def.slug}` }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // Quick action items
  const quickActions = [
    { href: '/invoices/new', icon: Receipt, label: 'Ny faktura', desc: 'Skapa och skicka', accent: true },
    { href: '/customers', icon: Users, label: 'Ny kund', desc: 'Lägg till kunduppgifter' },
    { href: '/transactions', icon: ArrowLeftRight, label: 'Transaktioner', desc: 'Bokför' },
  ]

  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'God natt' : hour < 10 ? 'Godmorgon' : hour < 14 ? 'Hej' : hour < 18 ? 'God eftermiddag' : 'God kväll'

  const passedDeadlinesCount = summary.deadlines.filter(d => !d.is_completed && new Date(d.due_date) <= new Date()).length
  const pendingReceiptsCount = summary.receiptQueue
    ? summary.receiptQueue.pending_review_count + summary.receiptQueue.unmatched_receipts_count
    : 0
  const todoCount = summary.uncategorizedCount + summary.overdueInvoicesCount + pendingReceiptsCount + passedDeadlinesCount

  return (
    <div className="stagger-enter">
      {/* Header */}
      <header className="mb-12">
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ''}
        </h1>
      </header>

      {/* 4 Key Summary Cards */}
      <section className="mb-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Card 1: Resultat */}
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

          {/* Card 2: Att få betalt */}
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

          {/* Card 3: Banksaldo */}
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
                  <p className="text-xs text-muted-foreground mt-1">Importera transaktioner</p>
                </CardContent>
              </Card>
            </Link>
          )}

          {/* Card 4: Att göra */}
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-2">Att göra</p>
              <div role="status" aria-live="polite">
                {todoCount > 0 ? (
                  <>
                    <p className="font-display text-xl font-medium tabular-nums leading-tight text-warning-foreground">
                      {todoCount}
                      <span className="text-sm ml-0.5 text-muted-foreground font-normal">st</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Behöver åtgärdas
                    </p>
                  </>
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

      {/* Quick actions */}
      <section id="quick-actions" className="mb-10">
        <h2 className="font-display text-lg font-medium mb-4">Snabbåtgärder</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {quickActions.map((action) => {
            const Icon = action.icon
            return (
              <Link key={action.href} href={action.href} className="group">
                <div className={cn(
                  'flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors duration-150 active:scale-[0.98]',
                  action.accent
                    ? 'border-primary/20 bg-primary/[0.03] hover:bg-primary/[0.06]'
                    : 'border-border/40 hover:bg-muted/30'
                )}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5">
                      <Icon className={cn(
                        'h-3.5 w-3.5 flex-shrink-0',
                        action.accent ? 'text-primary' : 'text-muted-foreground'
                      )} />
                      {action.label}
                    </p>
                    <p className="text-xs text-muted-foreground truncate md:block">{action.desc}</p>
                  </div>
                </div>
              </Link>
            )
          })}
          {/* Extension quick actions */}
          {extensionQuickActions.map((action) => {
            const Icon = resolveIcon(action.icon)
            if (action.href) {
              return (
                <Link key={action.key} href={action.href} className="group">
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border/40 hover:bg-muted/30 active:scale-[0.98] transition-colors duration-150">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate flex items-center gap-1.5">
                        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        {action.label}
                      </p>
                      <p className="text-xs text-muted-foreground truncate md:block">{action.description}</p>
                    </div>
                  </div>
                </Link>
              )
            }
            return (
              <button
                key={action.key}
                onClick={() => window.dispatchEvent(new Event(action.event!))}
                className="group text-left"
              >
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border/40 hover:bg-muted/30 active:scale-[0.98] transition-colors duration-150">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      {action.label}
                    </p>
                    <p className="text-xs text-muted-foreground truncate md:block">{action.description}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* Alerts section */}
      {alertItems.length > 0 && (
        <section id="alerts-section" className="mb-10">
          <h2 className="font-display text-lg font-medium mb-4">Att hantera</h2>
          <div id="alerts-list" className="grid gap-3 md:grid-cols-2">
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

      {/* Upcoming deadlines — always visible */}
      {summary.deadlines && summary.deadlines.length > 0 && (
        <section className="mb-8">
          <UpcomingDeadlinesWidget deadlines={summary.deadlines} maxItems={8} />
        </section>
      )}

      {/* Tax todo widget — visible when there are incomplete tax deadlines */}
      {summary.deadlines?.some(d => d.deadline_type === 'tax' && !d.is_completed) && (
        <section className="mb-10">
          <TaxTodoWidget deadlines={summary.deadlines} />
        </section>
      )}

      {/* Collapsible details section */}
      <button
        onClick={() => setShowMore(!showMore)}
        aria-expanded={showMore}
        aria-controls="details-section"
        className="mb-6 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5"
      >
        {showMore ? 'Dölj detaljer' : 'Visa detaljer'}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showMore && 'rotate-180')} />
      </button>

      {showMore && (
        <div id="details-section">
          {/* Uncategorized transactions warning */}
          {summary.uncategorizedCount > 0 && (summary.uncategorizedIncome > 0 || summary.uncategorizedExpenses > 0) && (
            <section className="mb-10">
              <Link href="/transactions?tab=uncategorized" className="group">
                <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl border border-warning/30 bg-warning/[0.03] hover:bg-warning/[0.06] transition-colors">
                  <ArrowLeftRight className="h-4 w-4 text-warning-foreground flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">
                      {summary.uncategorizedCount} obokförda transaktioner
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {summary.uncategorizedIncome > 0 && (
                        <span>{formatCurrency(summary.uncategorizedIncome)} intäkter</span>
                      )}
                      {summary.uncategorizedIncome > 0 && summary.uncategorizedExpenses > 0 && ', '}
                      {summary.uncategorizedExpenses > 0 && (
                        <span>{formatCurrency(summary.uncategorizedExpenses)} kostnader</span>
                      )}
                      {' '}saknas i resultatet
                    </p>
                  </div>
                </div>
              </Link>
            </section>
          )}

          {/* Income/Expenses */}
          <section className="mb-10">
            <h2 className="font-display text-lg font-medium mb-4">Resultat</h2>
            <div className="grid md:grid-cols-2 gap-3">
              <Card>
                <CardContent className="p-5">
                  <p className="text-sm text-muted-foreground mb-3">Intäkter</p>
                  <div>
                    <p className="font-display text-2xl font-medium tabular-nums leading-tight">
                      {formatLargeNumber(summary.mtd.income)}
                      <span className="text-base ml-1 text-muted-foreground font-normal">kr</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">denna månad</p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/30">
                    <div className="flex items-baseline justify-between">
                      <p className="text-xs text-muted-foreground">I år</p>
                      <p className="text-sm font-medium tabular-nums">{formatCurrency(summary.ytd.income)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5">
                  <p className="text-sm text-muted-foreground mb-3">Kostnader</p>
                  <div>
                    <p className="font-display text-2xl font-medium tabular-nums leading-tight">
                      {formatLargeNumber(summary.mtd.expenses)}
                      <span className="text-base ml-1 text-muted-foreground font-normal">kr</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">denna månad</p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-border/30">
                    <div className="flex items-baseline justify-between">
                      <p className="text-xs text-muted-foreground">I år</p>
                      <p className="text-sm font-medium tabular-nums">{formatCurrency(summary.ytd.expenses)}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
