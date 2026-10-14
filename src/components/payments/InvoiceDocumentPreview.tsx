'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DocumentPreview } from '@/components/bookkeeping/DocumentPreview'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { SlideOver, SlideOverBody, SlideOverContent, SlideOverHeader } from '@/components/ui/slide-over'
import { documentPreviewKind } from '@/lib/documents/preview-kind'
import {
  checkAgainstDocument,
  invoiceDocumentFacts,
  referenceLabel,
  type InvoiceDocumentFacts,
} from '@/lib/payments/orders/invoice-document'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { payeeLabel, type PaymentOrder, type PreparedPreviewLine } from './payments-client'

/**
 * The supplier's invoice beside the payment made from it, in the pay and the
 * approve dialogs: the person checks amount, payee and reference against the
 * document before approving or signing (Briefcase shows the same). One
 * invoice gets the document beside the payment; several get a document icon
 * per row that opens it in a side sheet.
 *
 * Nothing is fetched here beyond the document itself (the inline proxy): the
 * facts come with the dry run's lines and the order list.
 */

/** One payment as these views show it, whether a dry-run line or an order. */
export interface PaymentAgainstDocument {
  key: string
  supplier: string
  invoiceLabel: string | null
  /** The account paid, as a label ("BG 5050-1055"). */
  payee: string
  reference: { type: 'ocr' | 'message'; value: string }
  amount: number
  currency: string
  date: string | null
  facts: InvoiceDocumentFacts | null
}

export function paymentFromPreviewLine(line: PreparedPreviewLine, invoiceLabel?: string | null): PaymentAgainstDocument {
  return {
    key: line.supplier_invoice_id,
    supplier: line.supplier_name,
    invoiceLabel: invoiceLabel ?? line.supplier_invoice_number,
    payee: line.payee.label,
    reference: line.reference,
    amount: Number(line.amount),
    currency: line.currency,
    date: line.requested_execution_date,
    facts: line.document ?? null,
  }
}

export function paymentFromOrder(order: PaymentOrder): PaymentAgainstDocument {
  return {
    key: order.id,
    supplier: order.supplier_invoice?.supplier?.name ?? order.payee_name,
    invoiceLabel: order.supplier_invoice?.supplier_invoice_number ?? null,
    payee: payeeLabel(order),
    reference: { type: order.reference_type, value: order.reference },
    amount: Number(order.amount),
    currency: order.currency,
    date: order.requested_execution_date,
    facts: order.supplier_invoice ? invoiceDocumentFacts(order.supplier_invoice) : null,
  }
}

function paidReferenceLabel(reference: PaymentAgainstDocument['reference']): string {
  return reference.type === 'ocr' ? `OCR ${reference.value}` : reference.value
}

/**
 * One line per invoice: whether the payment pays the account and reference
 * the document states. A difference reads in the attention tone and names
 * what the invoice says; the text carries it, never the colour alone.
 */
export function DocumentCheckLine({ payment, className }: { payment: PaymentAgainstDocument; className?: string }) {
  const t = useTranslations('bank_payments_document')
  const facts = payment.facts
  if (!facts) return null
  const checks = checkAgainstDocument({ payee: payment.payee, reference: payment.reference.value }, facts)
  if (checks.payee === 'same' && checks.reference === 'same') {
    return <p className={cn('text-[12.5px] text-muted-foreground', className)}>{t('both_same')}</p>
  }
  const parts: Array<{ key: string; text: string; differs: boolean }> = []
  if (checks.payee === 'differs') parts.push({ key: 'payee', text: t('states', { value: facts.payee ?? '' }), differs: true })
  else if (checks.payee === 'missing') parts.push({ key: 'payee', text: t('states_no_payee'), differs: false })
  else parts.push({ key: 'payee', text: t('payee_same'), differs: false })
  if (checks.reference === 'differs') parts.push({ key: 'reference', text: t('states', { value: referenceLabel(facts.reference ?? '') }), differs: true })
  else if (checks.reference === 'missing') parts.push({ key: 'reference', text: t('states_no_reference'), differs: false })
  else parts.push({ key: 'reference', text: t('reference_same'), differs: false })
  return (
    <p className={cn('text-[12.5px] leading-5 text-muted-foreground', className)}>
      {parts.map((part, index) => (
        <span key={part.key}>
          {index > 0 && ' · '}
          <span className={part.differs ? 'text-attn' : undefined}>{part.text}</span>
        </span>
      ))}
    </p>
  )
}

/** The amount and due date as the invoice states them, quiet. */
function DocumentFactsLine({ facts }: { facts: InvoiceDocumentFacts | null }) {
  const t = useTranslations('bank_payments_document')
  if (!facts || facts.amount === null || !facts.due_date) return null
  return (
    <p className="text-[12.5px] text-muted-foreground tabular-nums">
      {t('on_document', { amount: formatCurrency(facts.amount, facts.currency ?? 'SEK'), date: formatDate(facts.due_date) })}
    </p>
  )
}

/**
 * The document's first page, in the shared viewer body (the inline proxy the
 * supplier invoice's own Visa dokument opens), with Öppna dokument beneath.
 */
export function InvoiceDocumentThumbnail({ facts, className }: { facts: InvoiceDocumentFacts | null; className?: string }) {
  const t = useTranslations('bank_payments_document')
  const documentId = facts?.document_id ?? null
  if (!documentId) {
    return (
      <div className={cn('grid place-items-center rounded-lg border border-border p-4 text-center text-[12.5px] text-muted-foreground', className)}>
        <span className="flex items-center gap-2">
          <FileText className="h-4 w-4" aria-hidden />
          {t('no_document')}
        </span>
      </div>
    )
  }
  const kind = documentPreviewKind(facts?.mime_type, facts?.file_name)
  const label = facts?.file_name ?? t('document_label')
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className={cn('overflow-hidden rounded-lg border border-border bg-background', className)}>
        <DocumentPreview
          src={`/api/documents/${documentId}/inline`}
          kind={kind}
          label={label}
          className="h-full w-full"
          imageClassName="mx-auto h-full max-w-full object-contain object-top"
          fallback={
            <div className="grid h-full w-full place-items-center p-4 text-center text-[12.5px] text-muted-foreground">
              {t('not_previewable')}
            </div>
          }
        />
      </div>
      <div>
        <DocumentViewButton documentId={documentId} label={t('open_document')} />
      </div>
    </div>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right tabular-nums">{children}</dd>
    </div>
  )
}

/**
 * One invoice: the document on the left, the payment on the right, stacked
 * on a phone. `payeeExtra` and `dateExtra` carry the caller's own notes
 * (another account on the invoice, a moved date) beside those rows.
 */
export function PaymentBesideDocument({
  payment,
  payeeExtra,
  dateExtra,
}: {
  payment: PaymentAgainstDocument
  payeeExtra?: ReactNode
  dateExtra?: ReactNode
}) {
  const t = useTranslations('bank_payments_document')
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <InvoiceDocumentThumbnail facts={payment.facts} className="h-[42vh] sm:h-[380px]" />
      <div className="min-w-0 space-y-2">
        <dl className="divide-y divide-border border-b border-border text-[13px]">
          <DetailRow label={t('label_supplier')}>
            <span className="block">{payment.supplier}</span>
            {payment.invoiceLabel && <span className="block text-[11px] text-muted-foreground">{payment.invoiceLabel}</span>}
          </DetailRow>
          <DetailRow label={t('label_payee')}>
            <span className="block">{payment.payee}</span>
            {payeeExtra}
          </DetailRow>
          <DetailRow label={t('label_reference')}>{paidReferenceLabel(payment.reference)}</DetailRow>
          {payment.date && (
            <DetailRow label={t('label_date')}>
              <span className="block">{formatDate(payment.date)}</span>
              {dateExtra}
            </DetailRow>
          )}
          <DetailRow label={t('label_amount')}>{formatCurrency(payment.amount, payment.currency)}</DetailRow>
        </dl>
        <DocumentCheckLine payment={payment} />
        <DocumentFactsLine facts={payment.facts} />
      </div>
    </div>
  )
}

/** The small document icon on a row of several; opens the side sheet. */
export function InvoiceDocumentButton({ payment, onOpen }: { payment: PaymentAgainstDocument; onOpen: (key: string) => void }) {
  const t = useTranslations('bank_payments_document')
  if (!payment.facts?.document_id) return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('show_document', { supplier: payment.supplier })}
      title={t('show_document', { supplier: payment.supplier })}
      onClick={() => onOpen(payment.key)}
    >
      <FileText className="h-4 w-4" aria-hidden />
    </Button>
  )
}

/**
 * The document of one row among several, in the right side sheet: the full
 * viewer, then the payment against it. Rendered inside the dialog's tree, so
 * a click in the sheet is inside the dialog and Esc closes the sheet first.
 */
export function InvoiceDocumentSheet({ payment, onClose }: { payment: PaymentAgainstDocument | null; onClose: () => void }) {
  const t = useTranslations('bank_payments_document')
  return (
    <SlideOver open={payment !== null} onOpenChange={(open) => !open && onClose()}>
      <SlideOverContent aria-describedby={undefined}>
        {payment && (
          <>
            <SlideOverHeader kicker={t('sheet_kicker')} title={payment.invoiceLabel ? `${payment.supplier} ${payment.invoiceLabel}` : payment.supplier} closeLabel={t('close')} />
            <SlideOverBody className="space-y-3">
              {payment.facts?.document_id ? (
                <DocumentViewerPane
                  documentId={payment.facts.document_id}
                  mime={payment.facts.mime_type}
                  fileName={payment.facts.file_name}
                  className="h-[60vh]"
                />
              ) : (
                <InvoiceDocumentThumbnail facts={payment.facts} className="h-[120px]" />
              )}
              <dl className="divide-y divide-border border-b border-border text-[13px]">
                <DetailRow label={t('label_payee')}>{payment.payee}</DetailRow>
                <DetailRow label={t('label_reference')}>{paidReferenceLabel(payment.reference)}</DetailRow>
                <DetailRow label={t('label_amount')}>{formatCurrency(payment.amount, payment.currency)}</DetailRow>
              </dl>
              <DocumentCheckLine payment={payment} />
              <DocumentFactsLine facts={payment.facts} />
            </SlideOverBody>
          </>
        )}
      </SlideOverContent>
    </SlideOver>
  )
}
