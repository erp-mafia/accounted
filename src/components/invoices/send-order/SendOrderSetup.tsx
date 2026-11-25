'use client'

import { useTranslations } from 'next-intl'
import { SendOrderEditor } from './SendOrderEditor'

interface SendOrderSetupProps {
  /** The order was saved in this visit: the block shows one sentence instead. */
  saved: boolean
  onSaved: () => void
}

/**
 * The block above the invoice list that asks how invoices should go out:
 * what is here, the list of ways with the recommended order, the split of the
 * customers and the one button. The page decides when it shows (the user is
 * in the rollout, may change settings, the company has no saved order).
 */
export function SendOrderSetup({ saved, onSaved }: SendOrderSetupProps) {
  const t = useTranslations('invoice_send_order')
  if (saved) {
    return (
      <p className="text-[13px] text-foreground/80" role="status">
        {t('saved')}
      </p>
    )
  }
  return (
    <section aria-labelledby="send-order-heading" className="space-y-1">
      <h2 id="send-order-heading" className="text-[15px] font-medium leading-[22px] text-strong">
        {t('heading')}
      </h2>
      <p className="text-[13px] text-foreground/80">{t('intro')}</p>
      <div className="pt-3">
        <SendOrderEditor
          saved={null}
          onSaved={onSaved}
          lead={(customerCount) =>
            customerCount === null ? null : (
              <p className="text-[13px] text-foreground/80">
                {customerCount > 0 ? t('customers_here', { count: customerCount }) : t('customers_none')}
              </p>
            )
          }
        />
      </div>
    </section>
  )
}
