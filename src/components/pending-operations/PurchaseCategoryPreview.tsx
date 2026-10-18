'use client'

import { Fragment, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  isPurchaseCategoryCode,
  PURCHASE_CATEGORY_I18N_NAMESPACE,
  purchaseCategoryNameKey,
} from '@/lib/categories/purchase-categories'

/**
 * set_inbox_purchase_category: what an underlag bought, proposed through
 * gnubok_set_inbox_purchase_category and set when approved
 * (lib/operations/inbox-purchase-category.ts). The approver checks three
 * things: the category, by its name in their language (the staged preview
 * carries the taxonomy code, which the generic preview would print raw);
 * which underlag, by the supplier and invoice number its reading names; and
 * whether it holds every time, i.e. also becomes the matched supplier's
 * instruction for new underlag, named as the register has it. That supplier
 * is pinned in the params: the approval writes to it or nothing. A code null
 * clears the choice.
 */
export function PurchaseCategoryPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const tc = useTranslations(PURCHASE_CATEGORY_I18N_NAMESPACE)
  const code = data.purchase_category_code
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const supplier = text(data.supplier_name)
  const invoiceNumber = text(data.invoice_number)
  const everyTime = data.every_time === true
  const matchedSupplier = text(data.matched_supplier_name)

  const rows: Array<{ label: string; value: ReactNode }> = [
    {
      label: t('preview_purchase_category'),
      value: isPurchaseCategoryCode(code)
        ? tc(purchaseCategoryNameKey(code))
        : code === null
          ? t('preview_purchase_category_cleared')
          : String(code ?? ''),
    },
  ]
  if (supplier) rows.push({ label: t('preview_field.supplier_name'), value: supplier })
  if (invoiceNumber) rows.push({ label: t('preview_field.invoice_number'), value: invoiceNumber })
  rows.push({
    label: t('preview_purchase_category_scope'),
    value: !everyTime
      ? t('preview_purchase_category_scope_item')
      : matchedSupplier
        ? t('preview_purchase_category_scope_every_time_named', { supplier: matchedSupplier })
        : t('preview_purchase_category_scope_every_time'),
  })

  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <span className="text-xs text-muted-foreground">{row.label}</span>
            <span className="min-w-0 break-words">{row.value}</span>
          </Fragment>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('preview_purchase_category_books_nothing')}</p>
    </div>
  )
}
