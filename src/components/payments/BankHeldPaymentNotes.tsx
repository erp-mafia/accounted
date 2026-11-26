'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { createClient } from '@/lib/supabase/client'
import type { OperationWarning } from '@/lib/operations/types'
import { PAYMENTS_PAGE_PATH } from '@/lib/payments/orders/page-path'
import {
  checkBankHeldPayments,
  UNSIGNED_BANK_PAYMENT_WARNING,
  type BankHeldPaymentVia,
} from '@/lib/payments/orders/signed-payment'

const NONE: OperationWarning[] = []

/**
 * What to tell the person about payments the bank holds for these supplier
 * invoices (checkBankHeldPayments), read again whenever the ids change. Empty
 * while it reads and for invoices without one. Pass no ids to read nothing
 * (a closed dialog, a customer invoice).
 */
export function useBankHeldPaymentWarnings(
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
): OperationWarning[] {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const supabase = useMemo(() => createClient(), [])
  const ids = [...new Set(supplierInvoiceIds)].join(',')
  const key = `${via}:${ids}`
  const [read, setRead] = useState<{ key: string; warnings: OperationWarning[] } | null>(null)

  useEffect(() => {
    if (!companyId || !ids) return
    let cancelled = false
    void checkBankHeldPayments(supabase, companyId, ids.split(','), via).then((check) => {
      if (!cancelled) setRead({ key: `${via}:${ids}`, warnings: check.warnings })
    })
    return () => {
      cancelled = true
    }
  }, [companyId, ids, supabase, via])

  return ids && read?.key === key ? read.warnings : NONE
}

/** The sentences, in the reader's language, for a confirm dialog's text: read now, when it opens. */
export async function readBankHeldPaymentSentences(
  companyId: string,
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
  locale: string,
): Promise<string[]> {
  const check = await checkBankHeldPayments(createClient(), companyId, supplierInvoiceIds, via)
  return check.warnings.map((warning) => (locale === 'en' ? warning.message_en : warning.message_sv))
}

/**
 * One sentence per payment the bank holds, said before the person confirms
 * paying or closing the invoice another way: ochre with the way to
 * Betalningar while a signed payment still goes out on its date (or the
 * orders could not be read), blue for an unsigned one, which never executes.
 * Renders nothing when there is none.
 */
export function BankHeldPaymentNotes({ warnings }: { warnings: readonly OperationWarning[] }) {
  const t = useTranslations('bank_held_payment')
  const locale = useLocale()
  if (warnings.length === 0) return null
  return (
    <div className="space-y-2" data-testid="bank-held-payment-notes">
      {warnings.map((warning, index) => {
        const unsigned = warning.code === UNSIGNED_BANK_PAYMENT_WARNING
        return (
          <AttnLine
            key={`${warning.code}:${index}`}
            tone={unsigned ? 'info' : 'warning'}
            action={unsigned ? undefined : { label: t('open_payments'), href: PAYMENTS_PAGE_PATH }}
          >
            {locale === 'en' ? warning.message_en : warning.message_sv}
          </AttnLine>
        )
      })}
    </div>
  )
}
