'use client'

import { isOwedInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { useState } from 'react'
import Link from 'next/link'
import type { CollectionsStage } from '@accounted/connect-contract'
import { Badge } from '@/components/ui/badge'
import { BrandMark } from '@/components/parties/BrandMark'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import type { CollectionCaseView } from '@/lib/collections/case'
import {
  actionDialogSpec,
  caseActionBody,
  caseAmounts,
  caseCardButtons,
  caseNotes,
  caseStageChip,
  caseTimeline,
  escalationAllows,
  eventShowsTime,
  escalationGate,
  messageLongEnough,
  pauseUntilProblem,
  type CardDialogAction,
} from '@/lib/collections/case-card'
import { collectionsErrorMessage } from '@/lib/collections/errors'
import { toggleDismissed } from '@/lib/collections/handover-dialog'
import type { CaseEscalationCheckView } from '@/lib/collections/invoice-collection'
import { CLOSE_REASON_KEYS, STAGE_LABEL_KEYS, caseKickerKey, pauseUntilWindow, type WithdrawFeeInfo } from '@/lib/collections/stages'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formatDate, formatDateTime } from '@/lib/utils'
import { formatKronor } from '@/lib/collections/amount-text'
import { BankCheckResult } from './BankCheckResult'
import {
  fetchCaseEscalation,
  postCaseAction,
  postForwardAction,
  postPossiblePaymentDismiss,
  useCaseWords,
  type InvoiceCollectionAvailability,
} from './case-client'

/**
 * The invoice's collection case (build spec 3.5), in owner words: who has
 * it and its number, the stage as one chip, what is unpaid and what the
 * customer must pay including fees, the next step and when, the actions the
 * provider's last snapshot offers, and the latest event (all of them on
 * request). An open case sits at the top of the invoice as a compact card
 * (placement 'top'); a closed or refused one with the invoice's history.
 * Rendered whenever a case exists, whatever the start gates say: an open
 * case is never hidden. The decisions live in lib/collections/case-card.ts;
 * this renders them.
 */

interface Props {
  invoiceId: string
  view: CollectionCaseView
  availability: InvoiceCollectionAvailability
  /** Whether withdrawing the open case may cost a fee now (GET withdrawFee). */
  withdrawFee: WithdrawFeeInfo | null
  /** The invoice's own status: a paid invoice whose case is still open reads as closing. */
  invoiceStatus: string
  canWrite: boolean
  onChanged: (next: CollectionCaseView) => void
  /** Re-read the case (the route refreshes it from the provider). */
  onRefresh: () => Promise<void> | void
  /** Open the handover dialog: a retry after a refused handover, or starting reminders on a delivered invoice. */
  onOpenHandover: () => void
  /** 'top': the compact card under the invoice header (an open case); 'history': further down (closed or refused). */
  placement?: 'top' | 'history'
}

export function CollectionCaseCard({
  invoiceId,
  view,
  availability,
  withdrawFee,
  invoiceStatus,
  canWrite,
  onChanged,
  onRefresh,
  onOpenHandover,
  placement = 'history',
}: Props) {
  const { t, tp, locale } = useCaseWords(availability.displayName)
  const { toast } = useToast()
  const [dialog, setDialog] = useState<CardDialogAction | null>(null)
  const [message, setMessage] = useState('')
  const [until, setUntil] = useState('')
  const [bankAttested, setBankAttested] = useState(false)
  const [dismissed, setDismissed] = useState<string[]>([])
  // undefined while the click-time check loads; null when it could not be read.
  const [escalation, setEscalation] = useState<CaseEscalationCheckView | null | undefined>(undefined)
  // The service answered that the free days have passed since the page loaded.
  const [feeForced, setFeeForced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [showAllEvents, setShowAllEvents] = useState(false)

  const today = todayIsoStockholm()
  const pauseWindow = pauseUntilWindow(today)
  const spec = dialog
    ? actionDialogSpec(dialog, { decisionKind: view.decisionKind, withdrawFeeMayApply: feeForced || withdrawFee?.mayApply !== false })
    : null
  const gate = spec?.escalation ? escalationGate(escalation, dismissed) : null
  const untilProblem = spec?.until ? pauseUntilProblem(until, today) : null
  const canConfirm =
    !!spec && messageLongEnough(spec, message) && untilProblem === null && (gate === null || escalationAllows(gate, bankAttested))

  const stageLabel = (stage: CollectionsStage) =>
    stage === 'unknown' ? (view.providerStateLabel ?? stage) : tp(STAGE_LABEL_KEYS[stage], { label: view.providerStateLabel ?? '' })
  const errorText = (code: string) => collectionsErrorMessage(code, { provider: availability.displayName, locale })

  async function forwardAction(forwardId: string, action: 'retry' | 'resolve') {
    setBusy(true)
    const result = await postForwardAction(invoiceId, forwardId, action, locale)
    setBusy(false)
    if (!result.ok) {
      toast({ title: result.message, variant: 'destructive' })
      return
    }
    onChanged(result.data.case)
    toast({ title: tp(action === 'retry' ? 'forward_retry_done' : 'forward_resolve_done') })
  }

  async function dismissPossiblePayment(hitId: string) {
    setBusy(true)
    const result = await postPossiblePaymentDismiss(invoiceId, hitId, locale)
    setBusy(false)
    if (!result.ok) {
      toast({ title: result.message, variant: 'destructive' })
      return
    }
    onChanged(result.data.case)
    toast({ title: tp('possible_payment_dismiss_done') })
  }

  async function loadEscalation() {
    setEscalation(undefined)
    setEscalation(await fetchCaseEscalation(invoiceId))
  }

  function openDialog(action: CardDialogAction) {
    setMessage('')
    setUntil('')
    setBankAttested(false)
    setDismissed([])
    setFeeForced(false)
    setError(null)
    setDialog(action)
    if (actionDialogSpec(action, { decisionKind: view.decisionKind, withdrawFeeMayApply: false }).escalation) {
      void loadEscalation()
    }
  }

  async function confirm() {
    if (!dialog || !spec) return
    setBusy(true)
    setError(null)
    const result = await postCaseAction(
      invoiceId,
      caseActionBody(dialog, spec, { message, until, bankAttested, dismissed, feeShown: spec.feeLine }),
      locale,
    )
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      if (result.code === 'COLLECTION_WITHDRAW_FEE_UNACKNOWLEDGED') setFeeForced(true)
      // The books or the bank changed since the dialog opened: check again before the person decides.
      if (spec.escalation && result.code?.startsWith('COLLECTION_')) {
        setBankAttested(false)
        void loadEscalation()
      }
      return
    }
    onChanged(result.data.case)
    setDialog(null)
    toast({ title: tp('action_done') })
  }

  async function refresh() {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const buttons = caseCardButtons(view, canWrite)
  const notes = caseNotes(view, invoiceStatus)

  const chip = caseStageChip(view)
  const amounts = caseAmounts(view)
  const timeline = caseTimeline(view.events, showAllEvents)

  const content = (
    <>
      {/* One line: who has the case, its number, the stage as the card's one chip; the freshness on the right. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        <span className="inline-flex items-center gap-2 font-medium">
          {availability.displayName && (
            <BrandMark name={availability.displayName} variant="mark" size={22} logoUrl={availability.markUrl} />
          )}
          {tp('card_title')}
        </span>
        {view.caseNumber && <span className="tabular-nums text-muted-foreground">{tp('card_case_number', { number: view.caseNumber })}</span>}
        {chip && <Badge variant={chip.variant}>{stageLabel(view.stage)}</Badge>}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:ml-auto">
          {view.lastSyncedAt && (
            <span className="tabular-nums">{tp('card_last_synced', { time: formatDateTime(view.lastSyncedAt) })}</span>
          )}
          {view.isOpen && (
            <button type="button" onClick={() => void refresh()} disabled={refreshing} className="underline underline-offset-2">
              {tp('card_refresh')}
            </button>
          )}
          {availability.portalUrl && view.submissionStatus === 'registered' && (
            <a href={availability.portalUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {tp('card_open_provider')}
            </a>
          )}
        </span>
      </div>

      {(view.submissionStatus === 'submitted' || view.submissionStatus === 'preparing') && (
        <p className="py-2 text-[13px] text-muted-foreground">
          {tp('card_registering')}
          {view.syncError && <span className="block">{tp('card_sync_error', { error: errorText(view.syncError) })}</span>}
        </p>
      )}

      {view.submissionStatus === 'failed' && (
        <div className="space-y-2 py-2 text-[13px]">
          <p>{tp('card_failed')}</p>
          {view.syncError && <p className="text-muted-foreground">{errorText(view.syncError)}</p>}
          {canWrite && availability.start === 'ready' && isOwedInvoiceStatus(invoiceStatus) && (
            <Button variant="outline" onClick={onOpenHandover}>
              {tp('card_retry')}
            </Button>
          )}
        </div>
      )}

      {view.submissionStatus === 'registered' && (
        <>
          {view.isOpen && view.decisionKind && (
            <p className="py-1 text-[13px]">{tp(`decision_${view.decisionKind}`, { label: view.providerStateLabel ?? '' })}</p>
          )}
          {!view.isOpen && (
            <p className="py-1 text-[13px] text-muted-foreground">
              {view.closeReason
                ? tp('card_closed', { date: view.closedAt ? formatDate(view.closedAt) : '', reason: tp(CLOSE_REASON_KEYS[view.closeReason]) })
                : stageLabel(view.stage)}
            </p>
          )}
          {(amounts.unpaid !== null || amounts.customerTotal !== null) && (
            <p className="py-1 text-[13px]">
              {amounts.unpaid !== null && (
                <span className="tabular-nums">{tp('card_amounts_unpaid', { amount: formatKronor(amounts.unpaid) })}</span>
              )}
              {amounts.unpaid !== null && amounts.customerTotal !== null && <span className="text-muted-foreground"> · </span>}
              {amounts.customerTotal !== null && (
                <span className="tabular-nums text-muted-foreground">
                  {tp('card_amounts_total', { amount: formatKronor(amounts.customerTotal) })}
                </span>
              )}
            </p>
          )}
          {view.isOpen && (view.nextActionDate || view.nextActionLabel) && (
            <p className="py-1 text-xs text-muted-foreground">
              {view.nextActionDate && view.nextActionLabel
                ? tp('card_next_dated', { label: view.nextActionLabel, date: formatDate(view.nextActionDate) })
                : view.nextActionDate
                  ? tp('card_next_date_only', { date: formatDate(view.nextActionDate) })
                  : tp('card_next', { label: view.nextActionLabel ?? '' })}
            </p>
          )}
          {view.isOpen && view.forwardsInFlight && (
            <p className="py-2 text-xs text-muted-foreground">{tp('card_forward_in_flight')}</p>
          )}
          {view.merged && <p className="py-2 text-xs text-muted-foreground">{tp('card_merged')}</p>}
          {notes.map((note) => (
            <p key={note} className={note.startsWith('card_paused_') ? 'py-2 text-xs text-attn' : 'py-2 text-xs text-muted-foreground'}>
              {tp(note)}
            </p>
          ))}
          {view.syncError && view.isOpen && (
            <p className="py-2 text-xs text-muted-foreground">{tp('card_sync_error', { error: errorText(view.syncError) })}</p>
          )}
          {view.outstandingMismatch && (
            <p className="py-2 text-xs text-attn">
              {tp(view.outstandingMismatch.provider > view.outstandingMismatch.expected ? 'card_mismatch_more' : 'card_mismatch_less', {
                provider_amount: formatKronor(view.outstandingMismatch.provider),
                expected: formatKronor(view.outstandingMismatch.expected),
              })}
            </p>
          )}
          {view.possiblePayments.map((payment) => (
            <div key={payment.id} className="py-2 text-xs">
              <p className="text-attn">
                {tp(`possible_payment_${payment.pauseState}`, { amount: formatKronor(payment.amount), date: formatDate(payment.date) })}
              </p>
              {canWrite && (
                <div className="flex flex-wrap items-center gap-3 pt-1.5">
                  <Link href={`/transactions?highlight=${encodeURIComponent(payment.transactionId)}`} className="underline underline-offset-2">
                    {tp('possible_payment_book')}
                  </Link>
                  <Button variant="ghost" disabled={busy} onClick={() => void dismissPossiblePayment(payment.id)}>
                    {tp('possible_payment_dismiss')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {view.forwardIssues.map((issue) => (
            <div key={issue.id} className="py-2 text-xs">
              <p className={issue.issue === 'retrying' ? 'text-muted-foreground' : 'text-attn'}>
                {tp(`forward_${issue.issue}_${issue.kind}${issue.issue === 'excess' ? '' : `_${issue.operation}`}`, {
                  amount: formatKronor(issue.amount),
                  ignored: formatKronor(issue.ignoredAmount ?? 0),
                  date: formatDate(issue.paymentDate),
                })}
              </p>
              {canWrite && issue.issue !== 'retrying' && (
                <div className="flex flex-wrap gap-2 pt-1.5">
                  {issue.issue === 'failed' && (
                    <Button variant="outline" disabled={busy} onClick={() => void forwardAction(issue.id, 'retry')}>
                      {tp('forward_retry')}
                    </Button>
                  )}
                  <Button variant="ghost" disabled={busy} onClick={() => void forwardAction(issue.id, 'resolve')}>
                    {tp('forward_resolve')}
                  </Button>
                </div>
              )}
            </div>
          ))}

          {buttons.length > 0 && (
            <div className="flex flex-wrap gap-2 py-2">
              {buttons.map((button) => (
                <Button
                  key={button.action}
                  variant={button.primary ? 'default' : 'outline'}
                  onClick={() => (button.kind === 'handover' ? onOpenHandover() : openDialog(button.action))}
                >
                  {tp(button.labelKey)}
                </Button>
              ))}
            </div>
          )}

          {/* Händelser, collapsed to the latest one until the person asks for all. */}
          <div className="pt-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground">{tp('card_timeline')}</p>
              {(timeline.hidden > 0 || showAllEvents) && view.events.length > 1 && (
                <button
                  type="button"
                  className="text-xs underline underline-offset-2"
                  aria-expanded={showAllEvents}
                  onClick={() => setShowAllEvents((v) => !v)}
                >
                  {showAllEvents ? tp('card_show_less') : tp('card_show_all', { count: view.events.length })}
                </button>
              )}
            </div>
            {view.events.length === 0 ? (
              <p className="py-2 text-[13px] text-muted-foreground">{tp('card_no_events')}</p>
            ) : (
              <ul className="divide-y divide-border text-[13px]" data-ph-mask="">
                {timeline.shown.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <span className="tabular-nums text-muted-foreground">
                      {eventShowsTime(event) ? formatDateTime(event.occurredAt) : formatDate(event.occurredAt)}
                    </span>
                    <span className="min-w-0 flex-1">
                      {event.kind === 'sync_error'
                        ? tp('event_sync_error', { error: errorText(event.label) })
                        : event.labelKey
                          ? tp(event.labelKey)
                          : event.label}
                    </span>
                    {event.amount !== null && <span className="tabular-nums">{formatKronor(event.amount)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Dialog open={dialog !== null} onOpenChange={(next) => !busy && !next && setDialog(null)}>
        {dialog && spec && (
          <DialogContent size="confirm">
            <DialogHeader>
              <DialogTitle className="text-lg">{tp(spec.titleKey)}</DialogTitle>
              {spec.bodyKeys.map((key) => (
                <DialogDescription key={key} className="text-[13px] leading-relaxed">
                  {tp(key)}
                </DialogDescription>
              ))}
            </DialogHeader>

            {gate && (
              <div className="space-y-2 text-[13px]">
                {gate.state === 'loading' && <p className="text-muted-foreground">{tp('escalation_checking')}</p>}
                {gate.state === 'unavailable' && <p className="text-muted-foreground">{tp('escalation_unavailable')}</p>}
                {gate.state === 'paid' && <p className="text-attn text-xs">{tp('escalation_paid')}</p>}
                {gate.state === 'not_reported' && (
                  <p className="text-attn text-xs">
                    {tp('escalation_not_reported', {
                      remaining: formatKronor(gate.remaining),
                      outstanding: formatKronor(gate.providerOutstanding),
                    })}
                  </p>
                )}
                {(gate.state === 'ok' || gate.state === 'candidates' || gate.state === 'attest') && escalation && (
                  <BankCheckResult
                    bank={escalation.bankCheck}
                    state={gate.bank}
                    dismissed={dismissed}
                    onToggleDismissed={(id) => setDismissed((d) => toggleDismissed(d, id))}
                    attested={bankAttested}
                    onAttestedChange={setBankAttested}
                    onSynced={() => void loadEscalation()}
                    tp={tp}
                  />
                )}
              </div>
            )}

            {spec.message && (
              <label className="block space-y-2 text-[13px]">
                {spec.message.labelKey && <span>{tp(spec.message.labelKey)}</span>}
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={2000} />
                {!messageLongEnough(spec, message) && message.length > 0 && (
                  <span className="text-xs text-muted-foreground">{tp('message_min')}</span>
                )}
              </label>
            )}
            {spec.until && (
              <label className="block space-y-2 text-[13px]">
                <span>{tp('pause_until')}</span>
                <Input
                  type="date"
                  value={until}
                  min={pauseWindow.earliest}
                  max={pauseWindow.latest}
                  onChange={(e) => setUntil(e.target.value)}
                />
                {untilProblem && <span className="text-xs text-muted-foreground">{tp(untilProblem)}</span>}
              </label>
            )}
            {error && <p className="text-[13px] text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)} disabled={busy}>
                {tp('send_cancel')}
              </Button>
              <Button variant={spec.destructive ? 'destructive' : 'default'} onClick={() => void confirm()} loading={busy} disabled={!canConfirm}>
                {tp(spec.confirmKey)}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )

  // Open: a compact card at the top of the invoice. Closed or refused: with the invoice's history further down.
  return placement === 'top' ? (
    <section aria-label={t(caseKickerKey(view.stage))} className="min-w-0 space-y-1 rounded-lg px-4 py-3 bg-control shadow-raised">
      {content}
    </section>
  ) : (
    <DetailSection kicker={t(caseKickerKey(view.stage))}>{content}</DetailSection>
  )
}
