'use client'

import { useTranslations } from 'next-intl'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatPeriodLabel } from '@/lib/reports/period-dates'
import type { VatFilingRecordWithChange } from '@/lib/vat/filed-period-changes'

/** Verifikat named before the rest collapse into "and N more". */
const NAMED_VOUCHERS = 3

function signed(amount: number): string {
  return amount > 0 ? `+${formatCurrency(amount)}` : formatCurrency(amount)
}

/**
 * The VAT page's attention line (design rule 6: one ochre sentence) for filed
 * periods whose books moved after the filing (lib/vat/filed-period-changes):
 * the newest such period, its ruta 49 change and the verifikat behind it,
 * with a link that opens the period. The change does not reach Skatteverket
 * by itself; what the company does about it is its own call, so the line
 * states the fact and nothing more.
 */
export function VatFiledChangesLine({
  changed,
  onOpen,
}: {
  /** Filing records with a non-null changed_after_filing, newest filing first. */
  changed: readonly VatFilingRecordWithChange[]
  onOpen: (record: VatFilingRecordWithChange) => void
}) {
  const t = useTranslations('reports')
  const first = changed[0]
  const change = first?.changed_after_filing
  if (!first || !change) return null

  const vouchers = change.verifikat.map((v) => v.voucher)
  const named = vouchers.slice(0, NAMED_VOUCHERS).join(', ')
  const rest = vouchers.length - NAMED_VOUCHERS
  const ruta49 = change.rutor_change.ruta49 ?? 0
  const values = {
    period: formatPeriodLabel(first.period_type, first.year, first.period),
    date: formatDate(first.filed_on),
    amount: signed(ruta49),
    vouchers: rest > 0 ? `${named} ${t('vat_filed_changed_more', { count: rest })}` : named,
  }

  return (
    <p className="attn text-[12.5px]">
      {ruta49 !== 0 ? t('vat_filed_changed_ruta49', values) : t('vat_filed_changed_rutor', values)}
      {changed.length > 1 && ` ${t('vat_filed_changed_others', { count: changed.length - 1 })}`}{' '}
      <button type="button" className="underline underline-offset-2" onClick={() => onOpen(first)}>
        {t('vat_filed_changed_open')}
      </button>
    </p>
  )
}
