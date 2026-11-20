'use client'

import { useTranslations } from 'next-intl'
import type { CustomerLossView } from '@/lib/customer-loss/view'
import { formatLossAmount } from '@/lib/customer-loss/text'

/**
 * The invoice page's kundförlust line (product decision F3): "Befarad
 * kundförlust bokförd" while a reserve is held (the invoice keeps its status,
 * the claim still stands), and the written-off note once the loss is
 * konstaterad. Renders nothing otherwise.
 */
export function CustomerLossNote({ view }: { view: CustomerLossView | null }) {
  const t = useTranslations('customer_loss')
  if (!view) return null
  if (view.invoiceStatus === 'written_off') {
    return (
      <div className="rounded-lg px-4 py-3 text-sm bg-control shadow-raised">
        <p className="font-medium">{t('written_off_note')}</p>
        {view.recovery && !view.recovery.booked && (
          <p className="mt-1 text-xs text-muted-foreground">{t('recovery_not_booked')}</p>
        )}
        {view.recovery?.booked && <p className="mt-1 text-xs text-muted-foreground">{t('recovered_note')}</p>}
        {view.recovery?.booked && view.recovery.caseOpen && (
          <p className="mt-1 text-xs text-muted-foreground">{t('recovery_case_open')}</p>
        )}
      </div>
    )
  }
  if (view.reserve > 0) {
    return (
      <div className="rounded-lg px-4 py-3 text-sm bg-control shadow-raised">
        <p className="font-medium">{t('doubtful_booked')}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('doubtful_booked_detail', { amount: formatLossAmount(view.reserve) })}
        </p>
      </div>
    )
  }
  return null
}
