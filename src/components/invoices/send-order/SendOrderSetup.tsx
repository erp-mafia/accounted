'use client'

import { useTranslations } from 'next-intl'
import type { SendOrderWay } from '@/lib/invoices/send-order'
import { SendOrderEditor } from './SendOrderEditor'

interface SendOrderSetupProps {
  /** The order was saved in this visit: the block shows one sentence instead. */
  saved: boolean
  /** The ways the company can use; the page shows the block only with at least two. */
  available: readonly SendOrderWay[]
  onSaved: () => void
}

/**
 * The block above the invoice list that asks how invoices should go out:
 * what is here, the list of ways with the recommended order, the split of the
 * customers and the one button. The page decides when it shows (the user is
 * in the rollout, may change settings, the company has no saved order).
 */
export function SendOrderSetup({ saved, available, onSaved }: SendOrderSetupProps) {
  const t = useTranslations('invoice_send_order')
  if (saved) {
    return (
      <p className="max-w-xl text-[13px] text-foreground/80" role="status">
        {t('saved')}
      </p>
    )
  }
  return (
    <section aria-labelledby="send-order-heading" className="max-w-xl space-y-6">
      <SendOrderEditor
        saved={null}
        available={available}
        onSaved={onSaved}
        lead={(customerCount) => (
          <div className="space-y-2">
            {customerCount === null ? null : (
              <p className="text-[13px] text-muted-foreground">
                {customerCount > 0 ? t('customers_here', { count: customerCount }) : t('customers_none')}
              </p>
            )}
            <h2 id="send-order-heading" className="text-[20px] font-medium text-strong">
              {t('heading')}
            </h2>
            <p className="text-[13px] text-muted-foreground">{t('intro')}</p>
          </div>
        )}
      />
    </section>
  )
}
