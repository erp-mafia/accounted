'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { formatCurrency, formatDate } from '@/lib/utils'
import { supplierInvoiceDisplayFigures } from '@/lib/bookkeeping/supplier-invoice-display-figures'
import type {
  RegisteredSupplierInvoice,
  SupplierInvoiceReferenceReuse,
} from '@/lib/supplier-invoices/duplicate-lookup'

/** Opens beside the editor: following it must not cost the person what they have typed. */
function RegisteredInvoiceLink({ invoice }: { invoice: RegisteredSupplierInvoice }) {
  const t = useTranslations('supplier_invoice_editor')
  return (
    <Link
      href={`/supplier-invoices/${invoice.id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {t('duplicate_warning_link')}
    </Link>
  )
}

/**
 * Where the named invoice's payment stands, so registering it again is not
 * paying it twice: "Den är betald 2026-10-28.", "Den ligger redan i en
 * betalning." (registeredInvoicePayment in lib/supplier-invoices/duplicate-lookup.ts).
 */
function paymentSentence(t: ReturnType<typeof useTranslations>, invoice: RegisteredSupplierInvoice): string {
  const { payment } = invoice
  switch (payment.state) {
    case 'paid':
      return t('duplicate_payment_paid', { date: payment.paid_at ? formatDate(payment.paid_at) : 'none' })
    case 'in_payment':
      return t('duplicate_payment_in_payment')
    case 'partially_paid':
      return t('duplicate_payment_partly_paid', {
        paid: formatCurrency(payment.paid_amount, invoice.currency),
        // The amount the invoice list shows for it (öresavrundning applied).
        total: formatCurrency(supplierInvoiceDisplayFigures(invoice).toPay, invoice.currency),
      })
    case 'unpaid':
      return t('duplicate_payment_unpaid')
  }
}

/**
 * "Fakturanummer 1001 används redan på verifikat A71. Den är betald
 * 2026-10-28.", or without a verifikat while it is not booked.
 */
export function duplicateNumberSentence(
  t: ReturnType<typeof useTranslations>,
  number: string,
  invoice: RegisteredSupplierInvoice,
): string {
  const sentence = invoice.voucher?.label
    ? t('duplicate_warning_line_voucher', { number, voucher: invoice.voucher.label })
    : t('duplicate_warning_line', { number })
  return `${sentence} ${paymentSentence(t, invoice)}`
}

/** Under the invoice number: the create route refuses this number, so the line is red. */
export function DuplicateNumberLine({ number, invoice }: { number: string; invoice: RegisteredSupplierInvoice }) {
  const t = useTranslations('supplier_invoice_editor')
  return (
    // data-ph-mask: the line carries the invoice number.
    <p className="text-xs text-destructive" data-ph-mask="">
      {duplicateNumberSentence(t, number, invoice)} <RegisteredInvoiceLink invoice={invoice} />
    </p>
  )
}

/** The ICU arguments that name an invoice: its number, else its ankomstnummer, and its verifikat. */
function invoiceName(invoice: RegisteredSupplierInvoice) {
  return {
    kind: invoice.supplier_invoice_number ? 'numbered' : 'arrival',
    // A string: a number argument would be grouped (1 234).
    number: invoice.supplier_invoice_number ?? String(invoice.arrival_number),
    voucher: invoice.voucher?.label ?? 'none',
  }
}

/**
 * The invoice that already carries the payment reference, named so it can be
 * told from the one being registered: number, date, amount and verifikat. A
 * twin, the same document again (the same date and amount), is named as one.
 * Either way the sentence says where that invoice's payment stands. The
 * editor shows it under the reference and the review dialog repeats it above
 * "Registrera ändå".
 */
export function ReusedReferenceSentence({ reuse }: { reuse: SupplierInvoiceReferenceReuse }) {
  const t = useTranslations('supplier_invoice_editor')
  const invoice = reuse.twin ?? reuse.invoice
  const sentence = reuse.twin
    ? t('reference_twin_line', invoiceName(invoice))
    : t('reference_reuse_line', {
        ...invoiceName(invoice),
        date: formatDate(invoice.invoice_date),
        // The amount the invoice list shows for it (öresavrundning applied).
        amount: formatCurrency(supplierInvoiceDisplayFigures(invoice).toPay, invoice.currency),
      })
  return (
    <>
      {sentence} {paymentSentence(t, invoice)} <RegisteredInvoiceLink invoice={invoice} />
    </>
  )
}

/** Under the payment reference: amber while it asks for an acknowledgement, quiet once reuse is the supplier's normal. */
export function ReusedReferenceLine({ reuse }: { reuse: SupplierInvoiceReferenceReuse }) {
  const t = useTranslations('supplier_invoice_editor')
  if (!reuse.needs_acknowledgement) {
    return <p className="text-xs text-muted-foreground">{t('reference_reuse_routine_line', { count: reuse.count })}</p>
  }
  return (
    <p className="text-xs text-attn" data-ph-mask="">
      <ReusedReferenceSentence reuse={reuse} />
    </p>
  )
}
