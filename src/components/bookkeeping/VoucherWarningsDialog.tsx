'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'

/**
 * The confirm step of the booking-time voucher guard
 * (VOUCHER_NEEDS_CONFIRMATION, lib/bookkeeping/voucher-warnings-guard.ts):
 * the warnings the server found, in the person's language, with "Bokför
 * ändå" and a way back to the lines. The caller owns the retry: it sends the
 * same request again with `acknowledged_warnings` set to these codes.
 */
export default function VoucherWarningsDialog({
  warnings,
  processing,
  onCancel,
  onConfirm,
  cancelLabel,
  intro,
}: {
  warnings: VoucherWarning[] | null
  processing: boolean
  onCancel: () => void
  onConfirm: () => void
  /** The way back, when there are no lines to correct (a bank row booked by category). Default: "Rätta verifikationen". */
  cancelLabel?: string
  /** The line above the warnings, when they are about several rows of a selection. Default: "Kontrollera det här innan du bokför:". */
  intro?: string
}) {
  const t = useTranslations('voucherWarnings')
  const locale = useLocale()

  return (
    <Dialog
      open={warnings !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>{t('title')}</DialogTitle>
            <HelpPopover className="shrink-0">{t('help')}</HelpPopover>
          </div>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{intro ?? t('intro')}</p>
          <ul className="space-y-3">
            {(warnings ?? []).map((warning, index) => {
              const voucherId = typeof warning.details.journal_entry_id === 'string' ? warning.details.journal_entry_id : null
              return (
                <li key={`${warning.code}-${index}`} className="space-y-1 rounded-lg p-3 text-sm bg-control shadow-raised">
                  <div>{locale === 'en' ? warning.message_en : warning.message_sv}</div>
                  {voucherId && (
                    <a
                      href={`/bookkeeping/${voucherId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-muted-foreground underline underline-offset-2"
                    >
                      {t('view_voucher')}
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={onCancel} disabled={processing}>
              {cancelLabel ?? t('cancel')}
            </Button>
            <Button onClick={onConfirm} loading={processing}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
