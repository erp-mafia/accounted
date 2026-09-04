'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { downloadFile } from '@/lib/browser/download-file'
import { failureDescription } from '@/lib/browser/action-failure'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'

interface PreviewLine {
  id: string
  supplier_name: string
  invoice_number: string
  amount: number
  payment_date: string
  payee: { type: string; label: string }
  reference: { type: 'ocr' | 'invoice_number'; value: string }
  warnings: Array<'unattested' | 'already_batched' | 'ocr_invalid' | 'payee_city_missing'>
  active_batch_id: string | null
}

interface Preview {
  eligible: PreviewLine[]
  excluded: Array<{ id: string; reason: string }>
  total: number
  debtor_ok: boolean
  debtor_missing?: 'iban' | 'bic' | 'org_number'
}

interface PaymentFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Selected supplier-invoice ids from the list page. */
  invoiceIds: string[]
  /** Called after a batch was created and its file downloaded. */
  onCreated: () => void
  /** Lets the dialog name the excluded invoices, not just their ids. */
  invoiceLabelById?: ReadonlyMap<string, string>
}

export default function PaymentFileDialog({
  open,
  onOpenChange,
  invoiceIds,
  onCreated,
  invoiceLabelById,
}: PaymentFileDialogProps) {
  const t = useTranslations('supplier_payment_files')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirmAlreadyBatched, setConfirmAlreadyBatched] = useState(false)
  // Per-line editable overrides, keyed by invoice id. Values stay as input
  // strings so partially-typed numbers do not fight the user.
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [dates, setDates] = useState<Record<string, string>>({})

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setPreview(null)
    setAmounts({})
    setDates({})
    setConfirmAlreadyBatched(false)
    try {
      const res = await fetch('/api/supplier-invoices/payment-batches/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'pain001', ids: invoiceIds }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: t('preview_failed_title'),
          description: getErrorMessage(body, { locale }),
          variant: 'destructive',
        })
        onOpenChange(false)
        return
      }
      setPreview(body.data as Preview)
    } catch {
      toast({
        title: t('preview_failed_title'),
        description: getErrorMessage(null, { locale }),
        variant: 'destructive',
      })
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }, [invoiceIds, locale, onOpenChange, t, toast])

  useEffect(() => {
    if (open) loadPreview()
  }, [open, loadPreview])

  const lineAmount = useCallback(
    (line: PreviewLine): number => {
      const raw = amounts[line.id]
      if (raw === undefined) return line.amount
      const parsed = Number.parseFloat(raw.replace(',', '.'))
      return Number.isFinite(parsed) ? parsed : 0
    },
    [amounts],
  )

  const total = useMemo(
    () => (preview ? preview.eligible.reduce((sum, line) => sum + lineAmount(line), 0) : 0),
    [preview, lineAmount],
  )

  const hasAlreadyBatched =
    preview?.eligible.some((line) => line.warnings.includes('already_batched')) ?? false
  const hasInvalidAmount =
    preview?.eligible.some((line) => lineAmount(line) <= 0 || lineAmount(line) > line.amount) ??
    false

  const canCreate =
    !!preview &&
    preview.eligible.length > 0 &&
    preview.debtor_ok &&
    !hasInvalidAmount &&
    (!hasAlreadyBatched || confirmAlreadyBatched) &&
    !creating

  async function handleCreate() {
    if (!preview || creating) return
    setCreating(true)
    try {
      const res = await fetch('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format: 'pain001',
          items: preview.eligible.map((line) => ({
            supplier_invoice_id: line.id,
            amount: lineAmount(line),
            payment_date: dates[line.id] ?? line.payment_date,
          })),
          ...(confirmAlreadyBatched ? { confirm_already_batched: true } : {}),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: t('create_failed_title'),
          description: getErrorMessage(body, { locale }),
          variant: 'destructive',
        })
        // The server re-evaluated and something changed since the preview:
        // reload so the dialog shows the state the refusal was based on.
        loadPreview()
        return
      }

      const batch = body.data as { id: string; created_at: string }
      const datePart = batch.created_at.slice(0, 10).replace(/-/g, '')
      const shortId = batch.id.replace(/-/g, '').slice(0, 8)
      const result = await downloadFile({
        url: `/api/supplier-invoices/payment-batches/${batch.id}/file`,
        filename: `betalfil_${datePart}_${shortId}.xml`,
        locale,
      })
      if (!result.ok) {
        // The batch exists even though the download failed; the history page
        // can re-serve the identical file, so point there instead of implying
        // the whole operation failed.
        toast({
          title: t('download_failed_title'),
          description: failureDescription(result, {
            timeout: t('download_timeout'),
            network: t('download_network'),
          }),
          variant: 'destructive',
        })
      } else {
        toast({ title: t('created_toast') })
      }
      onCreated()
      onOpenChange(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialog_title')}</DialogTitle>
        </DialogHeader>

        {loading || !preview ? (
          <div className="space-y-3 py-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {!preview.debtor_ok && (
              <AttnLine
                action={
                  preview.debtor_missing === 'org_number'
                    ? { label: t('debtor_missing_org_link'), href: '/settings/company' }
                    : { label: t('debtor_missing_link'), href: '/settings/invoicing' }
                }
              >
                {preview.debtor_missing === 'bic'
                  ? t('debtor_missing_bic')
                  : preview.debtor_missing === 'org_number'
                    ? t('debtor_missing_org')
                    : t('debtor_missing_iban')}
              </AttnLine>
            )}

            {preview.eligible.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">{t('th_supplier')}</th>
                      <th className="py-2 pr-3 font-medium">{t('th_payee')}</th>
                      <th className="py-2 pr-3 font-medium">{t('th_reference')}</th>
                      <th className="py-2 pr-3 font-medium">{t('th_payment_date')}</th>
                      <th className="py-2 text-right font-medium">{t('th_amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.eligible.map((line) => (
                      <tr key={line.id} className="border-b border-border/60 align-middle">
                        <td className="max-w-0 w-1/3 py-2 pr-3">
                          <span className="block truncate">{line.supplier_name}</span>
                          <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{line.invoice_number}</span>
                            {line.warnings.map((warning) => (
                              <Badge
                                key={warning}
                                variant={warning === 'already_batched' ? 'warning' : 'outline'}
                                className="px-1.5 py-0 text-[10px] font-normal"
                              >
                                {t(`warning_${warning}`)}
                              </Badge>
                            ))}
                          </span>
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                          {line.payee.label}
                        </td>
                        {/* Cap on an inner block: Firefox ignores max-width on
                            a td when sizing columns. 108 = 120 minus pr-3. */}
                        <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                          <div className="max-w-[108px] truncate">{line.reference.value}</div>
                        </td>
                        <td className="whitespace-nowrap py-2 pr-3">
                          <Input
                            type="date"
                            value={dates[line.id] ?? line.payment_date}
                            onChange={(e) =>
                              setDates((prev) => ({ ...prev, [line.id]: e.target.value }))
                            }
                            className="h-8 w-[140px] text-xs tabular-nums"
                          />
                        </td>
                        <td className="whitespace-nowrap py-2 text-right">
                          <Input
                            inputMode="decimal"
                            value={amounts[line.id] ?? String(line.amount)}
                            onChange={(e) =>
                              setAmounts((prev) => ({ ...prev, [line.id]: e.target.value }))
                            }
                            aria-invalid={lineAmount(line) <= 0 || lineAmount(line) > line.amount}
                            className="h-8 w-[110px] text-right text-xs tabular-nums"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="py-2 pr-3 text-right text-muted-foreground">
                        {t('total_label')}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right font-medium tabular-nums">
                        {formatCurrency(total)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {preview.eligible.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">{t('none_eligible')}</p>
            )}

            {preview.excluded.length > 0 && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{t('excluded_title')}</p>
                {preview.excluded.map((row) => (
                  <p key={row.id}>
                    {invoiceLabelById?.get(row.id) ?? row.id}:{' '}
                    {t(`excluded_reason_${row.reason}`)}
                  </p>
                ))}
              </div>
            )}

            {/* The file downloads fine and only fails at the bank if the
                upload agreement is missing: say the precondition up front. */}
            <div className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground">{t('pain001_agreement_warning')}</span>
            </div>

            {hasAlreadyBatched && (
              <label className="flex items-start gap-2 text-xs">
                <Checkbox
                  checked={confirmAlreadyBatched}
                  onCheckedChange={(checked) => setConfirmAlreadyBatched(checked === true)}
                  className="mt-0.5"
                />
                <span className="text-muted-foreground">{t('confirm_already_batched')}</span>
              </label>
            )}

            <div className="flex items-center justify-end gap-3">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={creating}
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={!canCreate}>
                {creating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {t('create_and_download')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
