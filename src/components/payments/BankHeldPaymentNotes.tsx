'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { PAYMENTS_PAGE_PATH } from '@/lib/payments/orders/page-path'
import { UNSIGNED_BANK_PAYMENT_WARNING } from '@/lib/payments/orders/bank-held-codes'
import type { BankHeldPaymentVia, BankHeldPaymentWarning } from '@/lib/payments/orders/signed-payment'
import { askAboutBankHeldPayments, type BankHeldPaymentAnswer } from './bank-held-payments-client'

export interface BankHeldPaymentWarnings extends BankHeldPaymentAnswer {
  /** The answer for the invoices asked about has not come yet: hold the confirm meanwhile (BANK_PAYMENT_CHECK_TIMEOUT_MS at most). */
  pending: boolean
}

const NOTHING_ASKED: BankHeldPaymentWarnings = { warnings: [], failed: false, pending: false }

/**
 * What to tell the person about payments the bank holds for these supplier
 * invoices, asked again whenever the invoices change. While the answer is on
 * its way, what the last one said of an invoice still asked about stays, so
 * nothing flashes, and `pending` holds the confirm, for
 * BANK_PAYMENT_CHECK_TIMEOUT_MS (bank-held-payments-client.ts) at most. Pass
 * no ids to ask nothing (a closed dialog, a customer invoice).
 */
export function useBankHeldPaymentWarnings(
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
): BankHeldPaymentWarnings {
  const asked = [...new Set(supplierInvoiceIds)]
  const ids = asked.join(',')
  const key = `${via}:${ids}`
  const [read, setRead] = useState<BankHeldPaymentAnswer & { key: string; answered: boolean }>({
    key,
    answered: false,
    warnings: [],
    failed: false,
  })
  // Other invoices asked about (adjusted during render, not in an effect):
  // until their answer comes, only what was said of those still asked about stays.
  if (read.key !== key) {
    const still = new Set(asked)
    setRead({
      key,
      answered: false,
      failed: false,
      warnings: read.warnings.filter((warning) => !!warning.supplier_invoice_id && still.has(warning.supplier_invoice_id)),
    })
  }

  useEffect(() => {
    if (!ids) return
    let cancelled = false
    void askAboutBankHeldPayments(ids.split(','), via).then((answer) => {
      if (!cancelled) setRead({ key: `${via}:${ids}`, answered: true, ...answer })
    })
    return () => {
      cancelled = true
    }
  }, [ids, via])

  if (!ids) return NOTHING_ASKED
  return { warnings: read.warnings, failed: read.failed, pending: !read.answered }
}

/**
 * The sentences, in the reader's language, for a confirm dialog's text: asked
 * when the confirm is asked for, for BANK_PAYMENT_CHECK_TIMEOUT_MS at most.
 * `checkFailed` is the dialog's sentence for a check that did not run.
 */
export async function readBankHeldPaymentSentences(
  supplierInvoiceIds: readonly string[],
  via: BankHeldPaymentVia,
  locale: string,
  checkFailed: string,
): Promise<string[]> {
  const answer = await askAboutBankHeldPayments(supplierInvoiceIds, via)
  return [
    ...answer.warnings.map((warning) => (locale === 'en' ? warning.message_en : warning.message_sv)),
    ...(answer.failed ? [checkFailed] : []),
  ]
}

/**
 * One sentence per payment the bank holds, said before the person confirms
 * paying or closing the invoice another way: ochre with the way to
 * Betalningar while a signed payment still goes out on its date (or the
 * check did not run), blue for an unsigned one, which never executes.
 * Renders nothing when there is none.
 */
export function BankHeldPaymentNotes({ warnings, failed = false }: { warnings: readonly BankHeldPaymentWarning[]; failed?: boolean }) {
  const t = useTranslations('bank_held_payment')
  const locale = useLocale()
  if (warnings.length === 0 && !failed) return null
  const toPayments = { label: t('open_payments'), href: PAYMENTS_PAGE_PATH }
  return (
    <div className="space-y-2" data-testid="bank-held-payment-notes">
      {warnings.map((warning, index) => {
        const unsigned = warning.code === UNSIGNED_BANK_PAYMENT_WARNING
        return (
          <AttnLine
            key={`${warning.code}:${warning.payment_order_id ?? index}`}
            tone={unsigned ? 'info' : 'warning'}
            action={unsigned ? undefined : toPayments}
          >
            {locale === 'en' ? warning.message_en : warning.message_sv}
          </AttnLine>
        )
      })}
      {failed && <AttnLine action={toPayments}>{t('check_failed')}</AttnLine>}
    </div>
  )
}
