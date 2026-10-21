'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import type { CustomerLossErrorCode } from '@/lib/customer-loss/errors'
import { isIsoDateShaped } from '@/lib/invariants'
import type { CustomerLossView, PreviewLine } from '@/lib/customer-loss/view'
import { cn, formatDate } from '@/lib/utils'
import { customerLossCanSend, customerLossSummary, formatLossAmount } from '@/lib/customer-loss/text'
import { accountWithName } from '@/lib/collections/voucher-text'
import { useAccounts } from '@/lib/reference-data/hooks'
import { getBasLoadedByNumber } from '@/lib/bookkeeping/bas-lazy'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import { postCustomerLoss, uploadEvidence } from './use-customer-loss'

interface Props {
  invoiceId: string
  invoiceNumber: string | null
  view: CustomerLossView
  /** The collections provider's name for the open-case warning, or the neutral word. */
  providerName: string
  today: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}

type Kind = 'doubtful' | 'confirmed'

const REFUSAL_KEYS: Partial<Record<CustomerLossErrorCode, string>> = {
  CUSTOMER_LOSS_CURRENCY_UNSUPPORTED: 'currency_unsupported',
  CUSTOMER_LOSS_DOUBTFUL_NOT_BOOKED: 'refusal_doubtful_not_booked',
  CUSTOMER_LOSS_ALREADY_RESERVED: 'refusal_already_reserved',
  CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED: 'refusal_deduction',
  CUSTOMER_LOSS_LEDGER_MISMATCH: 'refusal_ledger_mismatch',
  CUSTOMER_LOSS_INVOICE_NOT_BOOKED: 'refusal_not_booked_yet',
}

/**
 * "Bokför kundförlust" (build spec 3.10, founder decision F3). Befarad books
 * a reserve and leaves the invoice as it is; konstaterad writes the claim off
 * with evidence and lowers the output VAT. The voucher is shown before the
 * person confirms; nothing is booked until then.
 */
export function CustomerLossDialog({ invoiceId, invoiceNumber, view, providerName, today, open, onOpenChange, onDone }: Props) {
  const t = useTranslations('customer_loss')
  const { toast } = useToast()
  // Nothing is preselected: befarad and konstaterad differ in what happens to the invoice and its VAT.
  const [kind, setKind] = useState<Kind | null>(null)
  const [reason, setReason] = useState('')
  const [entryDate, setEntryDate] = useState(today)
  const [evidence, setEvidence] = useState<{ id: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadFailed, setUploadFailed] = useState(false)
  const [sending, setSending] = useState(false)
  // The voucher's rows sit behind "Visa verifikationen"; the sentence above says what is booked.
  const [showVoucher, setShowVoucher] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Start from a clean form each time the dialog opens.
  const [openedFor, setOpenedFor] = useState(open)
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) {
      setReason('')
      setEntryDate(today)
      setEvidence(null)
      setUploadFailed(false)
      setShowVoucher(false)
      setKind(null)
    }
  }

  const refusalText = (code: CustomerLossErrorCode) => t(REFUSAL_KEYS[code] ?? 'refusal_generic')
  const selected = kind === 'doubtful' ? view.doubtful : kind === 'confirmed' ? view.confirmed : null
  const lines: PreviewLine[] | null =
    kind === 'doubtful'
      ? view.doubtful.available
        ? view.doubtful.lines
        : null
      : kind === 'confirmed' && view.confirmed.available
        ? view.confirmed.lines
        : null
  const notBooked = kind === 'confirmed' && view.confirmed.available && view.confirmed.lines === null
  const needsEvidence = kind === 'confirmed'
  const summary = kind ? customerLossSummary(view, kind) : null
  const summaryText = !summary
    ? null
    : summary.key === 'summary_doubtful'
      ? t('summary_doubtful', { amount: formatLossAmount(summary.amount) })
      : [
          t(summary.key, { amount: formatLossAmount(summary.amount), vat: formatLossAmount(summary.vat) }),
          summary.reserveReleased > 0 ? t('summary_reserve_released', { reserve: formatLossAmount(summary.reserveReleased) }) : null,
        ]
          .filter(Boolean)
          .join(' ')
  const canSend = customerLossCanSend({
    kind,
    view,
    reason,
    entryDateValid: isIsoDateShaped(entryDate),
    hasEvidence: !!evidence,
    uploading,
  })

  async function pickEvidence(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setUploadFailed(false)
    const id = await uploadEvidence(file)
    setUploading(false)
    if (id) setEvidence({ id, name: file.name })
    else setUploadFailed(true)
  }

  async function send() {
    if (!kind) return
    setSending(true)
    const result = await postCustomerLoss(invoiceId, {
      kind,
      reason: reason.trim(),
      entry_date: entryDate,
      ...(kind === 'confirmed' ? { evidence_document_id: evidence?.id ?? null } : {}),
    })
    setSending(false)
    if (result.ok) {
      toast({ title: t('booked_toast') })
      onOpenChange(false)
      onDone()
    } else {
      toast({ title: t('failed_toast'), description: result.message ?? undefined, variant: 'destructive' })
    }
  }

  const kindOption = (value: Kind, label: string, help: string) => {
    const option = value === 'doubtful' ? view.doubtful : view.confirmed
    return (
      <button
        type="button"
        role="radio"
        aria-checked={kind === value}
        onClick={() => setKind(value)}
        className={cn(
          'w-full rounded-lg border border-border px-4 py-3 text-left transition-colors',
          kind === value ? 'bg-secondary' : 'hover:bg-secondary/60',
        )}
      >
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-1 text-xs text-muted-foreground">{help}</div>
        {!option.available && <div className="mt-2 text-xs text-muted-foreground">{refusalText(option.refusal)}</div>}
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title', { number: invoiceNumber ?? '' })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div role="radiogroup" className="space-y-2">
            {kindOption('doubtful', t('kind_doubtful'), t('kind_doubtful_help'))}
            {kindOption('confirmed', t('kind_confirmed'), t('kind_confirmed_help'))}
          </div>

          {kind === 'confirmed' && view.caseOpen && (
            <p className="text-sm text-destructive">{t('confirmed_case_open', { provider: providerName })}</p>
          )}

          {needsEvidence && selected?.available && (
            <div className="space-y-1.5">
              <Label>{t('evidence')}</Label>
              <p className="text-xs text-muted-foreground">{t('evidence_required')}</p>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,image/*"
                className="hidden"
                onChange={(e) => void pickEvidence(e.target.files?.[0])}
              />
              <div className="flex items-center gap-3">
                <Button type="button" variant="outline" size="sm" loading={uploading} onClick={() => fileInput.current?.click()}>
                  {t('evidence_choose')}
                </Button>
                {evidence && <span className="text-xs text-muted-foreground">{t('evidence_uploaded', { filename: evidence.name })}</span>}
              </div>
              {uploadFailed && <p className="text-xs text-destructive">{t('evidence_failed')}</p>}
            </div>
          )}

          {selected?.available && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="customer-loss-reason">{t('reason')}</Label>
                <Textarea
                  id="customer-loss-reason"
                  value={reason}
                  maxLength={500}
                  rows={2}
                  placeholder={t('reason_placeholder')}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="customer-loss-date">{t('date')}</Label>
                <Input id="customer-loss-date" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
              </div>
            </>
          )}

          {notBooked && <p className="text-sm text-muted-foreground">{t('not_booked')}</p>}

          {summaryText && <p className="text-[13px]">{summaryText}</p>}

          {lines && lines.length > 0 && (
            <div className="space-y-1.5">
              <button
                type="button"
                className="text-[12.5px] underline underline-offset-2"
                aria-expanded={showVoucher}
                onClick={() => setShowVoucher((v) => !v)}
              >
                {showVoucher ? t('hide_voucher') : t('show_voucher')}
              </button>
              {showVoucher && (
                <>
                  <p className="text-xs font-medium text-muted-foreground">{t('preview_heading', { date: formatDate(entryDate) })}</p>
                  <LossVoucherTable lines={lines} t={t} />
                </>
              )}
            </div>
          )}

          {kind === 'confirmed' && selected?.available && <p className="text-xs text-muted-foreground">{t('recovered_note')}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void send()} loading={sending} disabled={!canSend}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The voucher's rows with account names from the chart (read only once the person opens the voucher). */
function LossVoucherTable({ lines, t }: { lines: PreviewLine[]; t: (key: string) => string }) {
  const { accounts } = useAccounts(true)
  // Names an account the company chart does not hold yet (BAS standard name), once the chunk lands.
  useBasReference()
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="text-xs text-muted-foreground">
          <th className="py-1 text-left font-normal">{t('preview_account')}</th>
          <th className="py-1 text-right font-normal">{t('preview_debit')}</th>
          <th className="py-1 text-right font-normal">{t('preview_credit')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => (
          <tr key={`${line.account_number}-${i}`} className="border-t border-border">
            <td className="py-1 pr-3">{accountWithName(line.account_number, accounts, getBasLoadedByNumber(line.account_number)?.account_name)}</td>
            <td className="py-1 text-right tabular-nums">{line.debit_amount > 0 ? formatLossAmount(line.debit_amount) : ''}</td>
            <td className="py-1 text-right tabular-nums">{line.credit_amount > 0 ? formatLossAmount(line.credit_amount) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
