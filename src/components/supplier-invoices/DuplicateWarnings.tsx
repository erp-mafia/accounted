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

/** "Fakturanummer 1001 används redan på verifikat A71", or without a verifikat while it is not booked. */
export function duplicateNumberSentence(
  t: ReturnType<typeof useTranslations>,
  number: string,
  invoice: RegisteredSupplierInvoice,
): string {
  return invoice.voucher?.label
    ? t('duplicate_warning_line_voucher', { number, voucher: invoice.voucher.label })
    : t('duplicate_warning_line', { number })
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

/**
 * The invoice that already carries the payment reference, named so it can be
 * told from the one being registered: number, date, amount and verifikat.
 * The editor shows it under the reference and the review dialog repeats it
 * above "Registrera ändå".
 */
export function ReusedReferenceSentence({ reuse }: { reuse: SupplierInvoiceReferenceReuse }) {
  const t = useTranslations('supplier_invoice_editor')
  const { invoice } = reuse
  return (
    <>
      {t('reference_reuse_line', {
        kind: invoice.supplier_invoice_number ? 'numbered' : 'arrival',
        // A string: a number argument would be grouped (1 234).
        number: invoice.supplier_invoice_number ?? String(invoice.arrival_number),
        date: formatDate(invoice.invoice_date),
        // The amount the invoice list shows for it (öresavrundning applied).
        amount: formatCurrency(supplierInvoiceDisplayFigures(invoice).toPay, invoice.currency),
        voucher: invoice.voucher?.label ?? 'none',
      })}{' '}
      <RegisteredInvoiceLink invoice={invoice} />
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
