'use client'

import { useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import type { InvoicePartiesVerdict } from '@/lib/invoices/invoice-parties'

interface InvoicePartiesNoticeProps {
  /** invoicePartiesVerdict (lib/invoices/invoice-parties.ts), the answer issuable gives the send. */
  verdict: InvoicePartiesVerdict
  /** The invoice's customer, where the buyer's address is added. */
  customerId: string | null | undefined
  /** Owner/admin may open the company details; others are asked to get them filled in. */
  canEditCompany: boolean
  className?: string
}

/**
 * The seller's and the buyer's name and address before an invoice is issued
 * (crm#2080): a missing one that the send refuses, with where to fix it, or
 * the note that a förenklad faktura goes out without the buyer's address.
 * Nothing when both are there.
 */
export function InvoicePartiesNotice({ verdict, customerId, canEditCompany, className }: InvoicePartiesNoticeProps) {
  const t = useTranslations('invoice_parties')
  if (verdict === 'ok') return null
  if (verdict === 'seller_missing') {
    return canEditCompany ? (
      <AttnLine className={className} action={{ label: t('seller_fix'), href: '/settings/company' }}>
        {t('seller_missing')}
      </AttnLine>
    ) : (
      <AttnLine className={className}>
        {t('seller_missing')} {t('seller_ask_admin')}
      </AttnLine>
    )
  }
  return (
    <AttnLine
      className={className}
      action={customerId ? { label: t('open_customer'), href: `/customers/${customerId}` } : undefined}
    >
      {t(verdict === 'buyer_missing' ? 'buyer_missing' : 'buyer_simplified')}
    </AttnLine>
  )
}
