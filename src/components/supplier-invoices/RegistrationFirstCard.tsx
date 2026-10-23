'use client'

import { useTranslations } from 'next-intl'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { formatDate } from '@/lib/utils'

/** The registration verifikat a payment preview returns as `registration_entry`. */
export interface RegistrationEntryPreview {
  entry_date: string
  description: string
  lines: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description: string | null
  }>
}

/**
 * The first of the two verifikat a payment of a still unbooked supplier
 * invoice posts (defer_invoice_booking): the invoice's own registration, booked
 * by the Bokför step on its registration date (supplierInvoiceRegistrationDate),
 * read-only. The payment's own rows follow in the "Bokföring" card below it.
 */
export function RegistrationFirstCard({ entry }: { entry: RegistrationEntryPreview }) {
  const t = useTranslations('tx_invoice_match')
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('registration_first_title')}</p>
        <p className="text-xs text-muted-foreground">
          {t('registration_first_note', { date: formatDate(entry.entry_date) })}
        </p>
      </div>
      <VoucherLinesTable
        withCurrency
        redundantTexts={[entry.description]}
        lines={entry.lines.map((line) => ({
          account_number: line.account_number,
          description: line.line_description,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
        }))}
      />
    </div>
  )
}
