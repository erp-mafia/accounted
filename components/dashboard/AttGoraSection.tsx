'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { visibleWorklistTotal } from '@/lib/worklist/visible-total'
import {
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileWarning,
  HandCoins,
  Inbox,
  Landmark,
  Loader2,
  ReceiptText,
  Scale,
  ShieldCheck,
  Stamp,
} from 'lucide-react'
import type { ExpensePayoutDue, SuggestedMatch, WorklistCounts } from '@/lib/worklist/types'

/**
 * AttGoraSection: the dashboard's unified worklist ("Att göra").
 *
 * One flat ledger of everything actionable, grouped into four bands by
 * session intent: Bokför (the daily loop), Betala (money the company owes a
 * person for utlägg), Granska & komplettera (close the gaps), Bevaka
 * (time-driven). Every count comes from lib/worklist (the same
 * source as the sidebar badges) so the numbers can never disagree.
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
  /** People owed for registered, unpaid utlägg: one Betala row each. */
  expensePayouts?: ExpensePayoutDue[]
  expiringBankConnections?: ExpiringBankConnection[]
  /**
   * True while the setup checklist is open and the company has zero posted
   * journal entries. An empty ledger is not an achievement: the all-clear
   * state then says "nothing here yet" instead of a false "all caught up".
   */
  emptyLedger?: boolean
  /**
   * False when the company has no active bank connection. The all-clear state
   * then explains that nothing flows in automatically and offers "Anslut bank"
   * instead of a bare "all caught up": for a disconnected company the silence
   * is a setup gap, not an achievement. Defaults to true so a fetch error
   * degrades to the ordinary all-clear copy, never to a wrong nag.
   */
  hasActiveBankConnection?: boolean
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
      className="group flex w-full items-start gap-3 border-b border-border px-1 py-3.5 transition-colors duration-150 hover:bg-secondary/30"
    >
      <span className="mt-px w-[18px] shrink-0 text-muted-foreground" aria-hidden>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px]">{label}</p>
        {detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 pt-px">
        {badge}
        <Badge variant="secondary" className="font-normal tabular-nums">
          {count}
        </Badge>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      </span>
    </Link>
  )
}

function BandHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pt-5 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
      {children}
    </p>
  )
}

export default function AttGoraSection({
  worklist,
  suggestedMatches,
  expensePayouts = [],
  expiringBankConnections = [],
  emptyLedger = false,
  hasActiveBankConnection = true,
}: AttGoraSectionProps) {
  const t = useTranslations('dashboard')
  const { toast } = useToast()
  // The Dokumentinkorg is a paid (AI) surface: a non-payer's home to-do list
  // must not offer a row that jumps to the gated workspace. Mirrors the sidebar
  // + command palette gate; the page itself enforces it server-side.
  const hasAi = useCapability(CAPABILITY.ai)

  const [counts, setCounts] = useState(worklist.counts)
  const [total, setTotal] = useState(worklist.total)
  const [matches, setMatches] = useState(suggestedMatches)
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set())
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // A confirmed match books a journal entry, so the server-derived
  // emptyLedger flag goes stale the moment one succeeds in this session.
  const [postedSinceLoad, setPostedSinceLoad] = useState(false)

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
      // Stale counts self-correct on the next page load: never block the
      // flow. Note this is a browser console.error and nothing collects it:
      // the observability sink (lib/observability) is server-side and has no
      // client adapter, so a systematically broken counts endpoint currently
      // hides behind silently frozen numbers until someone reports it.
      console.error('[att-gora] worklist counts refetch failed', err)
    }
  }

  async function handleConfirmMatch(match: SuggestedMatch) {
    setConfirmingId(match.transaction_id)
    try {
      const url =
        match.kind === 'invoice'
          ? `/api/transactions/${match.transaction_id}/match-invoice`
          : match.kind === 'rot_rut_payout'
            ? `/api/transactions/${match.transaction_id}/match-rot-rut-payout`
            : match.kind === 'expense_payout'
              ? `/api/transactions/${match.transaction_id}/match-expense-payout`
              : `/api/transactions/${match.transaction_id}/match-supplier-invoice`
      const body =
        match.kind === 'invoice'
          ? { invoice_id: match.candidate_id }
          : match.kind === 'rot_rut_payout'
            ? { request_ids: match.request_ids ?? [match.candidate_id] }
            : match.kind === 'expense_payout'
              ? { claim_ids: match.claim_ids ?? [] }
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
      setPostedSinceLoad(true)
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
      }, 200)
      void refetchCounts()
    } catch {
      toast({ title: t('suggested_failed_toast'), variant: 'destructive' })
    } finally {
      setConfirmingId(null)
    }
  }

  const showInboxDocuments = hasAi && counts.inbox_document > 0
  const bokforRows =
    counts.book_transaction > 0 ||
    counts.book_skattekonto > 0 ||
    showInboxDocuments ||
    matches.length > 0
  const betalaRows = expensePayouts.length > 0
  const granskaRows =
    counts.supplier_invoice_approval > 0 ||
    counts.verifikat_missing_document > 0 ||
    counts.pending_operations > 0
  const bevakaRows =
    counts.overdue_invoice > 0 ||
    counts.deadline_action > 0 ||
    counts.reconciliation_due > 0 ||
    expiringBankConnections.length > 0
  const allClear = !bokforRows && !betalaRows && !granskaRows && !bevakaRows

  // The header total must equal what the section actually shows, computed off
  // the same visibleWorklistTotal helper as the dashboard KPI tile so the two
  // can never drift: the hidden paid inbox row is subtracted for non-payers,
  // else the header would count work the section no longer renders.
  const displayTotal = visibleWorklistTotal({
    total,
    inboxDocumentCount: counts.inbox_document,
    hasAi,
    extra: expiringBankConnections.length,
  })

  return (
    <section aria-label={t('att_gora_title')}>
      {/* Pane header: Geist title + quiet count over a hairline */}
      <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
        <h2 className="font-sans text-sm font-medium">{t('att_gora_title')}</h2>
        <p className="text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {allClear
            ? emptyLedger && !postedSinceLoad
              ? t('att_gora_new_status')
              : t('all_done')
            : t('att_gora_left', { count: displayTotal })}
        </p>
      </div>

      <div>
          {allClear ? (
            emptyLedger && !postedSinceLoad ? (
              <EmptyState
                icon={BookOpen}
                title={t('att_gora_new_title')}
                description={t('att_gora_new_body')}
                className="py-10"
              />
            ) : hasActiveBankConnection ? (
              <EmptyState
                icon={CheckCircle2}
                title={t('att_gora_empty_title')}
                description={t('att_gora_empty_body')}
                className="py-10"
              />
            ) : (
              <EmptyState
                icon={Landmark}
                title={t('att_gora_no_bank_title')}
                description={t('att_gora_no_bank_body')}
                actionLabel={t('att_gora_no_bank_action')}
                actionHref="/settings/banking"
                className="py-10"
              />
            )
          ) : (
            <div className="pb-2">
              {bokforRows && (
                <div>
                  <BandHeader>{t('band_bokfor')}</BandHeader>
                  <div>
                    {counts.book_transaction > 0 && (
                      <WorklistRow
                        href="/transactions"
                        icon={ArrowLeftRight}
                        label={t('row_book_transactions')}
                        count={counts.book_transaction}
                      />
                    )}
                    {counts.book_skattekonto > 0 && (
                      <WorklistRow
                        href="/transactions?source=skatteverket"
                        icon={Landmark}
                        label={t('row_book_skattekonto')}
                        count={counts.book_skattekonto}
                      />
                    )}
                    {matches.length > 0 && (
                      <div className="px-4 py-3">
                        <p className="text-xs text-muted-foreground mb-2">
                          {t('suggested_title')}
                        </p>
                        <div>
                          {matches.map((match) => {
                            const isLeaving = leavingIds.has(match.transaction_id)
                            const isConfirming = confirmingId === match.transaction_id
                            return (
                              <div
                                key={match.transaction_id}
                                className={cn(
                                  'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
                                  isLeaving ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]',
                                )}
                              >
                                <div className="overflow-hidden pb-1">
                                  <div className="flex items-center gap-3 rounded-sm bg-secondary/40 px-3 py-2">
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
                                      : match.kind === 'rot_rut_payout'
                                        ? t('suggested_kind_rot_rut_payout')
                                        : match.kind === 'expense_payout'
                                          ? t('suggested_kind_expense_payout')
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
                                  className="shrink-0 h-10 w-10 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
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
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    {showInboxDocuments && (
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

              {betalaRows && (
                <div>
                  <BandHeader>{t('band_betala')}</BandHeader>
                  <div>
                    {expensePayouts.map((p) => (
                      <WorklistRow
                        key={p.key}
                        href="/expenses"
                        icon={HandCoins}
                        label={t('row_expense_payout', { name: p.claimant_name })}
                        detail={
                          p.claim_count === 1
                            ? t('row_expense_payout_detail_one', { date: formatDate(p.oldest_expense_date) })
                            : t('row_expense_payout_detail_other', {
                                count: p.claim_count,
                                date: formatDate(p.oldest_expense_date),
                              })
                        }
                        count={p.claim_count}
                        badge={
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatCurrency(p.total_sek)}
                          </span>
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {granskaRows && (
                <div>
                  <BandHeader>{t('band_granska')}</BandHeader>
                  <div>
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
                  <div>
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
                    {counts.reconciliation_due > 0 && (
                      <WorklistRow
                        href="/reconciliation"
                        icon={Scale}
                        label={t('row_reconciliation_due')}
                        detail={t('row_reconciliation_due_detail')}
                        count={counts.reconciliation_due}
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
      </div>
    </section>
  )
}
