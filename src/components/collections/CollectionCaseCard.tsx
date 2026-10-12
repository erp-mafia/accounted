'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { CollectionsStage } from '@accounted/connect-contract'
import { Button } from '@/components/ui/button'
import { DefRow, DetailSection } from '@/components/ui/detail-section'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import type { CollectionCaseView } from '@/lib/collections/case'
import {
  actionDialogSpec,
  caseActionBody,
  caseCardButtons,
  caseNotes,
  escalationAllows,
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
import { formatCurrency, formatDate, formatDateLong } from '@/lib/utils'
import { BankCheckResult } from './BankCheckResult'
import { CollectionChip } from './CollectionChip'
import {
  fetchCaseEscalation,
  postCaseAction,
  postForwardAction,
  postPossiblePaymentDismiss,
  useCaseWords,
  type InvoiceCollectionAvailability,
} from './case-client'

/**
 * The invoice's collection case (build spec 3.5): where it stands, what the
 * provider waits for, the amounts, the timeline, and the actions the
 * provider's last snapshot offers. Rendered whenever a case exists, whatever
 * the start gates say: an open case is never hidden. The decisions live in
 * lib/collections/case-card.ts; this renders them.
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
  /** Open the invoice's payment dialog: the customer says the invoice is paid. */
  onRegisterPayment: () => void
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
  onRegisterPayment,
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

  return (
    <DetailSection
      kicker={t(caseKickerKey(view.stage))}
      aside={
        <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {view.lastSyncedAt && (
            <span className="tabular-nums">{tp('card_last_synced', { time: formatDateLong(view.lastSyncedAt, locale) })}</span>
          )}
          {view.isOpen && (
            <button type="button" onClick={() => void refresh()} disabled={refreshing} className="underline underline-offset-2">
              {tp('card_refresh')}
            </button>
          )}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-3 pb-2 text-[13px]">
        <span>{tp('card_title')}</span>
        {view.caseNumber && <span className="tabular-nums text-muted-foreground">{tp('card_case_number', { number: view.caseNumber })}</span>}
        {view.isOpen && view.submissionStatus === 'registered' && <CollectionChip stage={view.stage} displayName={availability.displayName} />}
        {availability.portalUrl && view.submissionStatus === 'registered' && (
          <a href={availability.portalUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {tp('card_open_provider')}
          </a>
        )}
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
          {canWrite && availability.start === 'ready' && ['sent', 'overdue', 'partially_paid'].includes(invoiceStatus) && (
            <Button size="sm" variant="outline" onClick={onOpenHandover}>
              {tp('card_retry')}
            </Button>
          )}
        </div>
      )}

      {view.submissionStatus === 'registered' && (
        <>
          <DefRow label={tp('card_stage')}>
            <span>{stageLabel(view.stage)}</span>
            {view.isOpen && view.decisionKind && (
              <span className="block text-[12.5px] text-muted-foreground">
                {tp(`decision_${view.decisionKind}`, { label: view.providerStateLabel ?? '' })}
              </span>
            )}
            {!view.isOpen && view.closeReason && (
              <span className="block text-[12.5px] text-muted-foreground">
                {tp('card_closed', { date: view.closedAt ? formatDate(view.closedAt) : '', reason: tp(CLOSE_REASON_KEYS[view.closeReason]) })}
              </span>
            )}
          </DefRow>
          {view.outstandingPrincipal !== null && view.isOpen && (
            <DefRow label={tp('card_outstanding')}>
              <span className="tabular-nums">{formatCurrency(view.outstandingPrincipal)}</span>
            </DefRow>
          )}
          {view.isOpen && view.outstandingTotal !== null && view.outstandingTotal !== view.outstandingPrincipal && (
            <DefRow label={tp('card_outstanding_total')}>
              <span className="tabular-nums">{formatCurrency(view.outstandingTotal)}</span>
            </DefRow>
          )}
          {view.isOpen && (view.nextActionDate || view.nextActionLabel) && (
            <DefRow label={tp('card_next_step')}>
              <span>
                {view.nextActionDate
                  ? tp('card_next_step_value', { label: view.nextActionLabel ?? '', date: formatDate(view.nextActionDate) })
                  : view.nextActionLabel}
              </span>
            </DefRow>
          )}
          {view.isOpen && view.forwardsInFlight && (
            <p className="py-2 text-[12.5px] text-muted-foreground">{tp('card_forward_in_flight')}</p>
          )}
          {view.merged && <p className="py-2 text-[12.5px] text-muted-foreground">{tp('card_merged')}</p>}
          {notes.map((note) => (
            <p key={note} className={note.startsWith('card_paused_') ? 'py-2 text-[12.5px] text-attn' : 'py-2 text-[12.5px] text-muted-foreground'}>
              {tp(note)}
            </p>
          ))}
          {view.syncError && view.isOpen && (
            <p className="py-2 text-[12.5px] text-muted-foreground">{tp('card_sync_error', { error: errorText(view.syncError) })}</p>
          )}
          {view.outstandingMismatch && (
            <p className="py-2 text-[12.5px] text-attn">
              {tp(view.outstandingMismatch.provider > view.outstandingMismatch.expected ? 'card_mismatch_more' : 'card_mismatch_less', {
                provider_amount: formatCurrency(view.outstandingMismatch.provider),
                expected: formatCurrency(view.outstandingMismatch.expected),
              })}
            </p>
          )}
          {view.possiblePayments.map((payment) => (
            <div key={payment.id} className="py-2 text-[12.5px]">
              <p className="text-attn">
                {tp(`possible_payment_${payment.pauseState}`, { amount: formatCurrency(payment.amount), date: formatDate(payment.date) })}
              </p>
              {canWrite && (
                <div className="flex flex-wrap items-center gap-3 pt-1.5">
                  <Link href={`/transactions?highlight=${encodeURIComponent(payment.transactionId)}`} className="underline underline-offset-2">
                    {tp('possible_payment_book')}
                  </Link>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismissPossiblePayment(payment.id)}>
                    {tp('possible_payment_dismiss')}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {view.forwardIssues.map((issue) => (
            <div key={issue.id} className="py-2 text-[12.5px]">
              <p className={issue.issue === 'retrying' ? 'text-muted-foreground' : 'text-attn'}>
                {tp(`forward_${issue.issue}_${issue.kind}${issue.issue === 'excess' ? '' : `_${issue.operation}`}`, {
                  amount: formatCurrency(issue.amount),
                  ignored: formatCurrency(issue.ignoredAmount ?? 0),
                  date: formatDate(issue.paymentDate),
                })}
              </p>
              {canWrite && issue.issue !== 'retrying' && (
                <div className="flex flex-wrap gap-2 pt-1.5">
                  {issue.issue === 'failed' && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void forwardAction(issue.id, 'retry')}>
                      {tp('forward_retry')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forwardAction(issue.id, 'resolve')}>
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
                  size="sm"
                  variant={button.primary ? 'default' : 'outline'}
                  title={button.kind === 'payment' ? tp('already_paid_body') : undefined}
                  onClick={() =>
                    button.kind === 'handover' ? onOpenHandover() : button.kind === 'payment' ? onRegisterPayment() : openDialog(button.action)
                  }
                >
                  {tp(button.labelKey)}
                </Button>
              ))}
            </div>
          )}

          <div className="pt-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp('card_timeline')}</p>
            {view.events.length === 0 ? (
              <p className="py-2 text-[13px] text-muted-foreground">{tp('card_no_events')}</p>
            ) : (
              <ul className="divide-y divide-border text-[13px]" data-ph-mask="">
                {view.events.map((event) => (
                  <li key={event.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2">
                    <span className="tabular-nums text-muted-foreground">{formatDate(event.occurredAt)}</span>
                    <span className="min-w-0 flex-1">
                      {event.kind === 'sync_error'
                        ? tp('event_sync_error', { error: errorText(event.label) })
                        : event.labelKey
                          ? tp(event.labelKey)
                          : event.label}
                    </span>
                    {event.amount !== null && <span className="tabular-nums">{formatCurrency(event.amount)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <Dialog open={dialog !== null} onOpenChange={(next) => !busy && !next && setDialog(null)}>
        {dialog && spec && (
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:min-w-[460px] sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display text-lg tracking-tight">{tp(spec.titleKey)}</DialogTitle>
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
                {gate.state === 'paid' && <p className="text-attn text-[12.5px]">{tp('escalation_paid')}</p>}
                {gate.state === 'not_reported' && (
                  <p className="text-attn text-[12.5px]">
                    {tp('escalation_not_reported', {
                      remaining: formatCurrency(gate.remaining),
                      outstanding: formatCurrency(gate.providerOutstanding),
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
                    locale={locale}
                  />
                )}
              </div>
            )}

            {spec.message && (
              <label className="block space-y-2 text-[13px]">
                {spec.message.labelKey && <span>{tp(spec.message.labelKey)}</span>}
                <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={2000} />
                {!messageLongEnough(spec, message) && message.length > 0 && (
                  <span className="text-[12.5px] text-muted-foreground">{tp('message_min')}</span>
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
                {untilProblem && <span className="text-[12.5px] text-muted-foreground">{tp(untilProblem)}</span>}
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
    </DetailSection>
  )
}
