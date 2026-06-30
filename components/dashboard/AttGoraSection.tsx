'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  ArrowLeftRight,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileWarning,
  Inbox,
  Landmark,
  Loader2,
  ReceiptText,
  ShieldCheck,
  Stamp,
} from 'lucide-react'
import type { SuggestedMatch, WorklistCounts } from '@/lib/worklist/types'

/**
 * AttGoraSection — the dashboard's unified worklist ("Att göra").
 *
 * One flat ledger of everything actionable, grouped into three bands by
 * session intent: Bokför (the daily loop), Granska & komplettera (close the
 * gaps), Bevaka (time-driven). Every count comes from lib/worklist — the same
 * source as the sidebar badges — so the numbers can never disagree.
 *
 * Suggested transaction↔invoice matches render inline with one-click confirm:
 * the row posts to the existing match endpoints, fades out optimistically,
 * and the counts refetch from /api/worklist/counts.
 */

interface ExpiringBankConnection {
  id: string
  bank_name: string
  days_left: number
}

interface AttGoraSectionProps {
  worklist: WorklistCounts
  suggestedMatches: SuggestedMatch[]
  expiringBankConnections?: ExpiringBankConnection[]
  staleUncategorizedCount: number
}

interface WorklistRowProps {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  detail?: string
  count: number
  badge?: React.ReactNode
}

function WorklistRow({ href, icon: Icon, label, detail, count, badge }: WorklistRowProps) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/60 transition-colors duration-150"
    >
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{label}</p>
        {detail && <p className="text-xs text-muted-foreground mt-0.5 truncate">{detail}</p>}
      </div>
      {badge}
      <span className="font-display text-base tabular-nums shrink-0">{count}</span>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
    </Link>
  )
}

function BandHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

export default function AttGoraSection({
  worklist,
  suggestedMatches,
  expiringBankConnections = [],
  staleUncategorizedCount,
}: AttGoraSectionProps) {
  const t = useTranslations('dashboard')
  const { toast } = useToast()

  const [counts, setCounts] = useState(worklist.counts)
  const [total, setTotal] = useState(worklist.total)
  const [matches, setMatches] = useState(suggestedMatches)
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set())
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  async function refetchCounts() {
    try {
      const res = await fetch('/api/worklist/counts')
      if (!res.ok) throw new Error(`worklist counts refetch failed: ${res.status}`)
      const json = (await res.json().catch(() => ({}))) as { data?: WorklistCounts }
      if (json.data) {
        setCounts(json.data.counts)
        setTotal(json.data.total)
      }
    } catch (err) {
      // Stale counts self-correct on the next page load — never block the
      // flow, but keep the failure observable (Sentry captures console.error)
      // so a systematically broken counts endpoint doesn't hide behind
      // silently frozen numbers.
      console.error('[att-gora] worklist counts refetch failed', err)
    }
  }

  async function handleConfirmMatch(match: SuggestedMatch) {
    setConfirmingId(match.transaction_id)
    try {
      const url =
        match.kind === 'invoice'
          ? `/api/transactions/${match.transaction_id}/match-invoice`
          : `/api/transactions/${match.transaction_id}/match-supplier-invoice`
      const body =
        match.kind === 'invoice'
          ? { invoice_id: match.candidate_id }
          : { supplier_invoice_id: match.candidate_id }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok || result.error) {
        toast({
          title: t('suggested_failed_toast'),
          description: getErrorMessage(result, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('suggested_confirmed_toast') })
      // Fade the row out, drop it, then re-sync every count from the source
      // of truth (the match also booked a transaction, so several numbers move).
      setLeavingIds((prev) => new Set(prev).add(match.transaction_id))
      setTimeout(() => {
        setMatches((prev) => prev.filter((m) => m.transaction_id !== match.transaction_id))
        setLeavingIds((prev) => {
          const next = new Set(prev)
          next.delete(match.transaction_id)
          return next
        })
      }, 300)
      void refetchCounts()
    } catch {
      toast({ title: t('suggested_failed_toast'), variant: 'destructive' })
    } finally {
      setConfirmingId(null)
    }
  }

  const bokforRows = counts.book_transaction > 0 || counts.inbox_document > 0 || matches.length > 0
  const granskaRows =
    counts.supplier_invoice_approval > 0 ||
    counts.verifikat_missing_document > 0 ||
    counts.pending_operations > 0
  const bevakaRows =
    counts.overdue_invoice > 0 ||
    counts.deadline_action > 0 ||
    expiringBankConnections.length > 0
  const allClear = !bokforRows && !granskaRows && !bevakaRows

  // The header total must equal what the section actually shows: the worklist
  // total plus expiring bank connections, which are dashboard-only (not a
  // lib/worklist category). Every count that feeds this number has a row.
  const displayTotal = total + expiringBankConnections.length

  return (
    <section aria-label={t('att_gora_title')}>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-display text-lg">{t('att_gora_title')}</h2>
        <p className="text-sm text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {allClear ? t('all_done') : t('att_gora_left', { count: displayTotal })}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {allClear ? (
            <EmptyState
              icon={CheckCircle2}
              title={t('att_gora_empty_title')}
              description={t('att_gora_empty_body')}
              className="py-10"
            />
          ) : (
            <div className="pb-2">
              {bokforRows && (
                <div>
                  <BandHeader>{t('band_bokfor')}</BandHeader>
                  <div className="divide-y divide-border">
                    {counts.book_transaction > 0 && (
                      <WorklistRow
                        href="/transactions"
                        icon={ArrowLeftRight}
                        label={t('row_book_transactions')}
                        count={counts.book_transaction}
                        badge={
                          staleUncategorizedCount > 0 ? (
                            <Badge variant="warning" className="shrink-0">
                              {t('row_book_transactions_stale', { count: staleUncategorizedCount })}
                            </Badge>
                          ) : undefined
                        }
                      />
                    )}
                    {matches.length > 0 && (
                      <div className="px-4 py-3">
                        <p className="text-xs text-muted-foreground mb-2">
                          {t('suggested_title')}
                        </p>
                        <div className="space-y-1">
                          {matches.map((match) => {
                            const isLeaving = leavingIds.has(match.transaction_id)
                            const isConfirming = confirmingId === match.transaction_id
                            return (
                              <div
                                key={match.transaction_id}
                                className={cn(
                                  'flex items-center gap-3 rounded bg-secondary/40 px-3 py-2 transition-opacity duration-300',
                                  isLeaving && 'opacity-0',
                                )}
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm truncate">
                                    {match.transaction_description}
                                    <span className="text-muted-foreground tabular-nums">
                                      {' '}
                                      · {formatCurrency(
                                        Math.abs(match.transaction_amount),
                                        match.transaction_currency,
                                      )}
                                    </span>
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-0.5 truncate tabular-nums">
                                    <ArrowRight className="inline h-3 w-3 mr-1" aria-hidden />
                                    {match.kind === 'invoice'
                                      ? t('suggested_kind_invoice')
                                      : t('suggested_kind_supplier_invoice')}
                                    {match.candidate_number ? ` ${match.candidate_number}` : ''}
                                    {match.counterparty_name ? ` · ${match.counterparty_name}` : ''}
                                    {' · '}
                                    {formatDate(match.transaction_date)}
                                  </p>
                                </div>
                                <Link
                                  href={`/transactions?highlight=${match.transaction_id}`}
                                  aria-label={t('suggested_view')}
                                  title={t('suggested_view')}
                                  className="shrink-0 h-10 w-10 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                                >
                                  <Eye className="h-4 w-4" />
                                </Link>
                                <Button
                                  size="sm"
                                  className="shrink-0"
                                  disabled={!!confirmingId || isLeaving}
                                  onClick={() => void handleConfirmMatch(match)}
                                >
                                  {isConfirming ? (
                                    <>
                                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                      {t('suggested_confirm')}
                                    </>
                                  ) : (
                                    t('suggested_confirm')
                                  )}
                                </Button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    {counts.inbox_document > 0 && (
                      <WorklistRow
                        href="/e/general/invoice-inbox"
                        icon={Inbox}
                        label={t('row_inbox_documents')}
                        detail={t('row_inbox_documents_detail')}
                        count={counts.inbox_document}
                      />
                    )}
                  </div>
                </div>
              )}

              {granskaRows && (
                <div>
                  <BandHeader>{t('band_granska')}</BandHeader>
                  <div className="divide-y divide-border">
                    {counts.supplier_invoice_approval > 0 && (
                      <WorklistRow
                        href="/supplier-invoices"
                        icon={Stamp}
                        label={t('row_supplier_approval')}
                        count={counts.supplier_invoice_approval}
                      />
                    )}
                    {counts.verifikat_missing_document > 0 && (
                      <WorklistRow
                        href="/bookkeeping?missingUnderlag=true"
                        icon={FileWarning}
                        label={t('row_missing_underlag')}
                        count={counts.verifikat_missing_document}
                      />
                    )}
                    {counts.pending_operations > 0 && (
                      <WorklistRow
                        href="/pending"
                        icon={ShieldCheck}
                        label={t('row_pending_ops')}
                        count={counts.pending_operations}
                      />
                    )}
                  </div>
                </div>
              )}

              {bevakaRows && (
                <div>
                  <BandHeader>{t('band_bevaka')}</BandHeader>
                  <div className="divide-y divide-border">
                    {counts.overdue_invoice > 0 && (
                      <WorklistRow
                        href="/invoices?status=unpaid"
                        icon={ReceiptText}
                        label={t('row_overdue_invoices')}
                        count={counts.overdue_invoice}
                      />
                    )}
                    {counts.deadline_action > 0 && (
                      <WorklistRow
                        href="/deadlines"
                        icon={CalendarClock}
                        label={t('row_deadlines')}
                        count={counts.deadline_action}
                      />
                    )}
                    {expiringBankConnections.length > 0 && (
                      <WorklistRow
                        href="/settings/banking"
                        icon={Landmark}
                        label={t('bank_consent_expiring')}
                        detail={
                          expiringBankConnections[0].days_left === 1
                            ? t('bank_consent_detail_one', {
                                bank: expiringBankConnections[0].bank_name,
                                days: expiringBankConnections[0].days_left,
                              })
                            : t('bank_consent_detail_other', {
                                bank: expiringBankConnections[0].bank_name,
                                days: expiringBankConnections[0].days_left,
                              })
                        }
                        count={expiringBankConnections.length}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
