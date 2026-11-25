'use client'

import { useTranslations } from 'next-intl'
import { formatCurrency } from '@/lib/utils'

/**
 * The red moms line when the invoice states moms and its rows carry none
 * (invoiceTotalsCrosscheck `rowsCarryNoVat`): the whole moms is the
 * difference, so the line says where it belongs. The moms sats goes on the
 * cost row, and a part that is not deductible (half on leasing or hiring a
 * personbil, ML 2023:200 13 kap. 22 §) through Begränsat momsavdrag on that
 * row, which books it as cost on the row's account.
 */
export function RowsCarryNoVatLine({ vat, currency }: { vat: number; currency?: string | null }) {
  const t = useTranslations('supplier_invoice_editor')
  return (
    <p className="text-destructive">
      {t('crosscheck_vat_rows_none', { vat: formatCurrency(vat, currency) })}
    </p>
  )
}

/**
 * Under a row on an ingående moms account at 0 % (isInputVatAccountRow):
 * the row still books as typed, so the caption only informs.
 */
export function InputVatRowHint() {
  const t = useTranslations('supplier_invoice_editor')
  return <p className="text-xs text-muted-foreground">{t('row_input_vat_hint')}</p>
}
