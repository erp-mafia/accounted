'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import type { CollectionCaseView } from '@/lib/collections/case'
import type { EligibilityBlock } from '@/lib/collections/eligibility'
import {
  bankCheckState,
  handoverCanSend,
  handoverReloadsAfter,
  handoverRequestBody,
  handoverWording,
  initialStartStep,
  offeredStartSteps,
  toggleDismissed,
  type StartStep,
} from '@/lib/collections/handover-dialog'
import type { CollectionReadinessView } from '@/lib/collections/invoice-collection'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { BankCheckResult } from './BankCheckResult'
import { fetchCollectionReadiness, postOpenCase, useCaseWords, type InvoiceCollectionAvailability } from './case-client'

/**
 * "Skicka till inkasso" (build spec 3.4): one invoice at a time. The dialog
 * shows the claim and the checks as a checklist, never as a silently
 * disabled button; a person gives the attestations the facts call for
 * (the invoice reached the customer, an import is not paid elsewhere, a
 * customer's answer was handled, an unsynced bank shows no payment), and
 * every check runs again when the handover is committed.
 */

interface Props {
  invoiceId: string
  invoiceNumber: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  availability: InvoiceCollectionAvailability
  onDone: (next: CollectionCaseView) => void
}

const ROW = 'grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 py-2 text-[13px] sm:grid-cols-[11rem_minmax(0,1fr)]'

export function SendToCollectionDialog({ invoiceId, invoiceNumber, open, onOpenChange, availability, onDone }: Props) {
  const { tp, locale } = useCaseWords(availability.displayName)
  const { toast } = useToast()
  const [readiness, setReadiness] = useState<CollectionReadinessView | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [startStep, setStartStep] = useState<StartStep>('reminder')
  const [bankAttested, setBankAttested] = useState(false)
  const [deliveryAttested, setDeliveryAttested] = useState(false)
  const [responseAttested, setResponseAttested] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    setError(null)
    try {
      const next = await fetchCollectionReadiness(invoiceId)
      setReadiness(next)
      if (next) setStartStep(initialStartStep(next))
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [invoiceId])

  useEffect(() => {
    if (!open || availability.start !== 'ready') return
    setDismissed([])
    setBankAttested(false)
    setDeliveryAttested(false)
    setResponseAttested(false)
    void load()
  }, [open, availability.start, load])

  const answers = { startStep, dismissed, bankAttested, deliveryAttested, responseAttested }
  const bank = readiness ? bankCheckState(readiness.bankCheck, dismissed) : null
  const canSend = !!readiness && handoverCanSend(readiness, answers)
  const startSteps = readiness ? offeredStartSteps(readiness) : []

  function blockText(block: EligibilityBlock): string {
    if (block.code === 'elig_below_minimum') return tp(block.code, { amount: formatCurrency(Number(block.params?.amount ?? 0)) })
    return tp(block.code)
  }

  async function send() {
    if (!readiness) return
    setSending(true)
    setError(null)
    const result = await postOpenCase(invoiceId, handoverRequestBody(readiness, answers), locale)
    setSending(false)
    if (!result.ok) {
      setError(result.message)
      // The facts the person decided on changed: show the new ones (their marks and attestations start over).
      if (handoverReloadsAfter(result.code)) {
        setDismissed([])
        setBankAttested(false)
        void load()
      }
      return
    }
    toast(
      readiness.watching
        ? { title: tp('start_success_title') }
        : {
            title: tp('send_success_title'),
            description: result.data.registered ? tp('send_success_body') : tp('send_pending_body'),
          },
    )
    onDone(result.data.case)
    onOpenChange(false)
  }

  const wording = handoverWording(readiness, startStep)
  const title = tp(wording.title, { number: invoiceNumber ?? '' })

  return (
    <Dialog open={open} onOpenChange={(next) => !sending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle data-ph-mask="" className="font-display text-lg tracking-tight">
            {title}
          </DialogTitle>
          {availability.sandbox && <DialogDescription>{tp('sandbox_note')}</DialogDescription>}
        </DialogHeader>

        {availability.start === 'upgrade' && <UpgradeNote>{tp('upgrade_note')}</UpgradeNote>}
        {availability.start === 'activate' && (
          <p className="text-[13px] text-muted-foreground">
            {tp('activate_intro')}{' '}
            <Link href="/settings/collections" className="text-foreground underline underline-offset-2">
              {tp('activate_cta')}
            </Link>
          </p>
        )}

        {availability.start === 'ready' && (
          <div className="space-y-4">
            {loading && !readiness && (
              <div className="space-y-2" aria-label={tp('loading')}>
                <Skeleton className="h-4 w-2/3 rounded-sm" />
                <Skeleton className="h-4 w-1/2 rounded-sm" />
                <Skeleton className="h-4 w-3/4 rounded-sm" />
              </div>
            )}
            {loadFailed && (
              <p className="text-[13px] text-muted-foreground">
                {tp('load_failed')}{' '}
                <button type="button" onClick={() => void load()} className="text-foreground underline underline-offset-2">
                  {tp('card_retry')}
                </button>
              </p>
            )}

            {readiness && (
              <>
                {readiness.blocks.length > 0 && (
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp('send_checklist_heading')}</p>
                    <ul className="mt-2 space-y-1 text-[13px]">
                      {readiness.blocks.map((block) => (
                        <li key={block.code} className="flex items-baseline gap-2">
                          <span aria-hidden className="text-destructive">•</span>
                          <span>
                            {blockText(block)}
                            {block.code.startsWith('debtor_') && readiness.customer.id && (
                              <>
                                {' '}
                                <Link href={`/customers/${readiness.customer.id}`} className="underline underline-offset-2">
                                  {tp('debtor_fix_link')}
                                </Link>
                              </>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="divide-y divide-border border-y border-border" data-ph-mask="">
                  <div className={ROW}>
                    <span className="text-muted-foreground">{tp('send_row_customer')}</span>
                    <span className="min-w-0 truncate">{readiness.customer.name}</span>
                  </div>
                  <div className={ROW}>
                    <span className="text-muted-foreground">{tp('send_row_amount')}</span>
                    <span>
                      <span className="tabular-nums">{formatCurrency(readiness.claim.remaining)}</span>
                      {readiness.rotRut && <span className="mt-1 block text-[12.5px] text-muted-foreground">{tp('send_rot_rut_note')}</span>}
                    </span>
                  </div>
                  <div className={ROW}>
                    <span className="text-muted-foreground">{tp('send_row_overdue')}</span>
                    <span className="tabular-nums">
                      {tp('send_overdue_value', { days: readiness.overdueDays, date: formatDate(readiness.dueDate) })}
                    </span>
                  </div>
                  <div className={ROW}>
                    <span className="text-muted-foreground">{tp('send_row_address')}</span>
                    <span>
                      {readiness.customer.missingAddress.length === 0
                        ? tp('send_address_ok')
                        : tp('send_address_missing', {
                            fields: readiness.customer.missingAddress.map((f) => tp(`address_field_${f}`)).join(', '),
                          })}
                    </span>
                  </div>
                  {readiness.customer.kind === 'private' ? (
                    <div className={ROW}>
                      <span className="text-muted-foreground">{tp('send_row_identity_private')}</span>
                      <span>
                        {readiness.customer.identity === 'ok'
                          ? tp('send_identity_ok')
                          : tp(readiness.customer.identity === 'invalid' ? 'send_identity_invalid' : 'send_identity_missing')}
                        {readiness.customer.identity !== 'ok' && readiness.customer.id && (
                          <>
                            {' '}
                            <Link href={`/customers/${readiness.customer.id}`} className="underline underline-offset-2">
                              {tp('send_identity_add')}
                            </Link>
                          </>
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className={ROW}>
                      <span className="text-muted-foreground">{tp('send_row_identity_business')}</span>
                      <span>
                        {readiness.blocks.some((b) => b.code === 'debtor_missing_org_number' || b.code === 'debtor_invalid_org_number')
                          ? tp(readiness.blocks.some((b) => b.code === 'debtor_invalid_org_number') ? 'debtor_invalid_org_number' : 'debtor_missing_org_number')
                          : tp('send_identity_ok')}
                      </span>
                    </div>
                  )}
                  <div className={ROW}>
                    <span className="text-muted-foreground">{tp('send_row_reminder_fee')}</span>
                    <span>
                      {readiness.reminderFee.agreed && readiness.reminderFee.since
                        ? tp('send_reminder_fee_yes', { date: formatDate(readiness.reminderFee.since) })
                        : tp('send_reminder_fee_no')}
                    </span>
                  </div>
                  <div className={ROW}>
                    <span className="text-muted-foreground">{tp('send_row_interest')}</span>
                    <span>{tp('send_interest_none')}</span>
                  </div>
                  {bank && (
                    <div className={ROW}>
                      <span className="text-muted-foreground">{tp('send_row_bank_check')}</span>
                      <BankCheckResult
                        bank={readiness.bankCheck}
                        state={bank}
                        dismissed={dismissed}
                        onToggleDismissed={(id) => setDismissed((d) => toggleDismissed(d, id))}
                        attested={bankAttested}
                        onAttestedChange={setBankAttested}
                        onSynced={() => void load()}
                        tp={tp}
                        locale={locale}
                      />
                    </div>
                  )}
                </div>

                {readiness.deliveryAttestation && (
                  <div className="space-y-2 text-[13px]">
                    <p className="text-attn text-[12.5px]">
                      {tp(readiness.deliveryAttestation === 'imported' ? 'imported_warning' : 'not_delivered_warning')}
                    </p>
                    <label className="flex items-start gap-2">
                      <Checkbox checked={deliveryAttested} onCheckedChange={(v) => setDeliveryAttested(v === true)} className="mt-0.5" />
                      <span>{tp(readiness.deliveryAttestation === 'imported' ? 'imported_attest' : 'not_delivered_attest')}</span>
                    </label>
                  </div>
                )}
                {readiness.responseAttestation && (
                  <div className="space-y-2 text-[13px]">
                    <p className="text-attn text-[12.5px]">{tp('response_warning', { response: readiness.responseAttestation })}</p>
                    <label className="flex items-start gap-2">
                      <Checkbox checked={responseAttested} onCheckedChange={(v) => setResponseAttested(v === true)} className="mt-0.5" />
                      <span>{tp('response_attest')}</span>
                    </label>
                  </div>
                )}

                {startSteps.length > 0 && (
                  <fieldset className="space-y-2">
                    <legend className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{tp('send_start_with')}</legend>
                    {startSteps.map((step) => (
                      <label
                        key={step}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 text-[13px] transition-colors duration-150 hover:bg-secondary/35',
                          startStep === step && 'bg-secondary/40',
                        )}
                      >
                        <input
                          type="radio"
                          name="collection-start-step"
                          value={step}
                          checked={startStep === step}
                          onChange={() => setStartStep(step)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
                        />
                        <span>
                          <span className="block">{tp(step === 'reminder' ? 'send_start_reminder' : 'send_start_collection')}</span>
                          <span className="block text-[12.5px] text-muted-foreground">
                            {tp(step === 'reminder' ? 'send_start_reminder_help' : 'send_start_collection_help')}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}

                <div className="space-y-2 text-[12.5px] text-muted-foreground">
                  <p>{tp('send_explainer')}</p>
                  {availability.feeSummarySv && (
                    <p>
                      <span className="text-foreground">{tp('send_fees_heading')}: </span>
                      {availability.feeSummarySv}
                    </p>
                  )}
                  <p>{tp('send_exclusivity')}</p>
                </div>
              </>
            )}
            {error && <p className="text-[13px] text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {tp('send_cancel')}
          </Button>
          {availability.start === 'ready' && (
            <Button onClick={() => void send()} loading={sending} disabled={!canSend}>
              {tp(wording.confirm)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
