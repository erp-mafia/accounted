'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { createClient } from '@/lib/supabase/client'
import { PAYMENTS_PAGE_PATH } from '@/lib/payments/orders/page-path'
import {
  checkBankHeldPayments,
  UNSIGNED_BANK_PAYMENT_WARNING,
  type BankHeldPaymentVia,
  type BankHeldPaymentWarning,
} from '@/lib/payments/orders/signed-payment'

/**
 * How long a dialog waits for the read of the bank's payments: past it the
 * check reads as not run (SI_BANK_PAYMENT_CHECK_FAILED), so a confirm is held
 * no longer and Kreditera opens.
 */
export const BANK_PAYMENT_CHECK_TIMEOUT_MS = 2_000

export interface BankHeldPaymentWarnings {
  warnings: BankHeldPaymentWarning[]
  /** The read for the invoices asked about has not answered yet: hold the confirm meanwhile. */
  pending: boolean
}

const NOTHING_ASKED: BankHeldPaymentWarnings = { warnings: [], pending: false }

/**
 * What to tell the person about payments the bank holds for these supplier
 * invoices (checkBankHeldPayments), read again whenever the invoices change.
 * While a read is on its way, what the last one said of an invoice still
 * asked about stays, so nothing flashes, and `pending` holds the confirm, for
 * BANK_PAYMENT_CHECK_TIMEOUT_MS at most. Pass no ids to read nothing (a closed
 * dialog, a customer invoice).
 */
export function useBankHeldPaymentWarnings(
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
): BankHeldPaymentWarnings {
  const companyId = useCompanyOptional()?.company?.id ?? null
  const supabase = useMemo(() => createClient(), [])
  const asked = [...new Set(supplierInvoiceIds)]
  const ids = asked.join(',')
  const key = `${via}:${ids}`
  const [read, setRead] = useState<{ key: string; answered: boolean; warnings: BankHeldPaymentWarning[] }>({
    key,
    answered: false,
    warnings: [],
  })
  // Other invoices asked about (adjusted during render, not in an effect):
  // until their answer comes, only what was said of those still asked about stays.
  if (read.key !== key) {
    const still = new Set(asked)
    setRead({
      key,
      answered: false,
      warnings: read.warnings.filter((warning) => !!warning.supplier_invoice_id && still.has(warning.supplier_invoice_id)),
    })
  }

  useEffect(() => {
    if (!companyId || !ids) return
    let cancelled = false
    void checkBankHeldPayments(supabase, companyId, ids.split(','), via, { timeoutMs: BANK_PAYMENT_CHECK_TIMEOUT_MS }).then(
      (check) => {
        if (!cancelled) setRead({ key: `${via}:${ids}`, answered: true, warnings: check.warnings })
      },
    )
    return () => {
      cancelled = true
    }
  }, [companyId, ids, supabase, via])

  if (!companyId || !ids) return NOTHING_ASKED
  return { warnings: read.warnings, pending: !read.answered }
}

/**
 * The sentences, in the reader's language, for a confirm dialog's text: read
 * when the confirm is asked for, for BANK_PAYMENT_CHECK_TIMEOUT_MS at most.
 */
export async function readBankHeldPaymentSentences(
  companyId: string,
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
  locale: string,
): Promise<string[]> {
  const check = await checkBankHeldPayments(createClient(), companyId, supplierInvoiceIds, via, {
    timeoutMs: BANK_PAYMENT_CHECK_TIMEOUT_MS,
  })
  return check.warnings.map((warning) => (locale === 'en' ? warning.message_en : warning.message_sv))
}

/**
 * One sentence per payment the bank holds, said before the person confirms
 * paying or closing the invoice another way: ochre with the way to
 * Betalningar while a signed payment still goes out on its date (or the
 * orders could not be read), blue for an unsigned one, which never executes.
 * Renders nothing when there is none.
 */
export function BankHeldPaymentNotes({ warnings }: { warnings: readonly BankHeldPaymentWarning[] }) {
  const t = useTranslations('bank_held_payment')
  const locale = useLocale()
  if (warnings.length === 0) return null
  return (
    <div className="space-y-2" data-testid="bank-held-payment-notes">
      {warnings.map((warning, index) => {
        const unsigned = warning.code === UNSIGNED_BANK_PAYMENT_WARNING
        return (
          <AttnLine
            key={`${warning.code}:${warning.payment_order_id ?? index}`}
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

/**
 * The notes, then the actions that confirm (`children`), held while the read
 * is on its way. For a page that loads this module with next/dynamic and so
 * cannot call the hook itself: the read then stays out of its first load.
 */
export function BankHeldPaymentGate({
  supplierInvoiceIds,
  via,
  children,
}: {
  supplierInvoiceIds: readonly string[]
  via: BankHeldPaymentVia
  children: (pending: boolean) => ReactNode
}) {
  const { warnings, pending } = useBankHeldPaymentWarnings(supplierInvoiceIds, via)
  return (
    <>
      <BankHeldPaymentNotes warnings={warnings} />
      {children(pending)}
    </>
  )
}
