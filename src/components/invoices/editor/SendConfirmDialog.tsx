'use client'

import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  InvoiceAttachmentsSection,
  type InvoiceAttachmentsTarget,
} from '@/components/invoices/InvoiceAttachmentsSection'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import type { VoucherLineView } from '@/lib/bookkeeping/voucher-line-view'

export type ConfirmVoucher =
  /** `note`: what the send books besides this verifikat (periodiseringar). */
  | { kind: 'lines'; date: string; lines: VoucherLineView[]; note?: string }
  /** No lines to show: why (kontantmetoden, deferred booking, foreign currency). */
  | { kind: 'note'; text: string }

interface SendConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Label/value rows: recipient or channel, number, amount and date. */
  rows: Array<{ label: string; value: string }>
  voucher: ConfirmVoucher | null
  /** The EU VAT notice and its acknowledgement checkbox, when the send needs one. */
  extra?: ReactNode
  /**
   * Bilagor (#79): where the files picked here go, when this send emails
   * them (offersInvoiceAttachments); null or omitted shows none. The same
   * section as the invoice page's send dialog, so both send steps offer it.
   */
  attachments?: InvoiceAttachmentsTarget | null
  confirmLabel: string
  confirmDisabled: boolean
  busy: boolean
  onConfirm: () => void
}

/**
 * The small confirm before a send (design convention 10): what goes where,
 * the number the document locks to, the amount, and the verifikation it
 * books, stated before anything happens. Enter confirms.
 */
export function SendConfirmDialog({
  open,
  onOpenChange,
  title,
  rows,
  voucher,
  extra,
  attachments = null,
  confirmLabel,
  confirmDisabled,
  busy,
  onConfirm,
}: SendConfirmDialogProps) {
  const t = useTranslations('invoice_editor_shell')
  const tCommon = useTranslations('common')
  const confirmRef = useRef<HTMLButtonElement>(null)
  // A file still uploading holds the send. The section reports false again
  // when it mounts, so a busy flag left by a closed dialog never sticks.
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const holdForAttachments = attachments !== null && attachmentsBusy
  const sendDisabled = confirmDisabled || holdForAttachments

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        // Focus starts on the confirm button, so Enter sends (Cmd/Ctrl+Enter
        // opened the dialog). While a required tick is missing the button is
        // disabled and the default focus applies.
        onOpenAutoFocus={(event) => {
          if (confirmRef.current && !confirmRef.current.disabled) {
            event.preventDefault()
            confirmRef.current.focus()
          }
        }}
        onKeyDown={(event) => {
          // Enter sends (Cmd/Ctrl+Enter opened it): unless the focus is on a
          // control that owns Enter itself.
          const target = event.target as HTMLElement
          if (event.key !== 'Enter' || target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return
          if (target.getAttribute('role') === 'checkbox') return
          event.preventDefault()
          if (!sendDisabled && !busy) onConfirm()
        }}
      >
        <DialogHeader>
          <DialogTitle data-ph-mask="">{title}</DialogTitle>
          <DialogDescription className="sr-only">{t('confirm_description')}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]" data-ph-mask="">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>

        {attachments && (
          <InvoiceAttachmentsSection target={attachments} disabled={busy} onBusyChange={setAttachmentsBusy} />
        )}

        {voucher?.kind === 'lines' && (
          <div>
            <p className="pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('confirm_voucher_title', { date: voucher.date })}
            </p>
            <div data-ph-mask="">
              <VoucherLinesTable lines={voucher.lines} withCurrency showTotals />
            </div>
            {voucher.note && <p className="pt-2 text-[13px] text-muted-foreground">{voucher.note}</p>}
          </div>
        )}
        {voucher?.kind === 'note' && <p className="text-[13px] text-muted-foreground">{voucher.text}</p>}

        {extra}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {tCommon('cancel')}
          </Button>
          <Button ref={confirmRef} onClick={onConfirm} disabled={sendDisabled} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
