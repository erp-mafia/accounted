'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { formatAmount } from '@/lib/utils'
import type { DetectedCustomerColumns, ParsedCustomerRow } from '@/lib/import/customers/types'
import type { DetectedSupplierColumns, ParsedSupplierRow } from '@/lib/import/suppliers/types'
import type { DetectedArticleColumns, ParsedArticleRow } from '@/lib/import/articles/types'

/** One imported field, as the register review step shows it. */
export interface ReviewField<R> {
  label: string
  /** What the import writes for this row, ready to show; null when it writes nothing. */
  value: (row: R) => string | null
}

/**
 * The review fields of one register import, keyed by the detected-column key
 * each field is read from. Every column the detector knows (bar its confidence
 * score) must have an entry, so a column added to the import without one is a
 * type error rather than a field the review step silently hides. Key order is
 * display order.
 */
export type ReviewFields<C, R> = {
  readonly [K in Exclude<keyof C, 'confidence'> & string]: ReviewField<R>
}

export function useCustomerReviewFields(): ReviewFields<DetectedCustomerColumns, ParsedCustomerRow> {
  const t = useTranslations('import_review')
  const tType = useTranslations('customers')
  return useMemo(
    () => ({
      name_col: { label: t('field_name'), value: (r) => r.name },
      customer_number_col: { label: t('field_customer_number'), value: (r) => r.customer_number },
      org_number_col: { label: t('field_org_number'), value: (r) => r.org_number },
      customer_type_col: { label: t('field_customer_type'), value: (r) => tType(`type_${r.customer_type}`) },
      email_col: { label: t('field_email'), value: (r) => r.email },
      phone_col: { label: t('field_phone'), value: (r) => r.phone },
      address_line1_col: { label: t('field_address_line1'), value: (r) => r.address_line1 },
      address_line2_col: { label: t('field_address_line2'), value: (r) => r.address_line2 },
      postal_code_col: { label: t('field_postal_code'), value: (r) => r.postal_code },
      city_col: { label: t('field_city'), value: (r) => r.city },
      country_col: { label: t('field_country'), value: (r) => r.country },
      vat_number_col: { label: t('field_vat_number'), value: (r) => r.vat_number },
      payment_terms_col: {
        label: t('field_payment_terms'),
        value: (r) => t('days', { count: r.default_payment_terms }),
      },
      notes_col: { label: t('field_notes'), value: (r) => r.notes },
    }),
    [t, tType],
  )
}

export function useSupplierReviewFields(): ReviewFields<DetectedSupplierColumns, ParsedSupplierRow> {
  const t = useTranslations('import_review')
  const tType = useTranslations('suppliers')
  return useMemo(
    () => ({
      name_col: { label: t('field_name'), value: (r) => r.name },
      org_number_col: { label: t('field_org_number'), value: (r) => r.org_number },
      supplier_type_col: { label: t('field_supplier_type'), value: (r) => tType(`type_${r.supplier_type}`) },
      email_col: { label: t('field_email'), value: (r) => r.email },
      phone_col: { label: t('field_phone'), value: (r) => r.phone },
      address_line1_col: { label: t('field_address_line1'), value: (r) => r.address_line1 },
      address_line2_col: { label: t('field_address_line2'), value: (r) => r.address_line2 },
      postal_code_col: { label: t('field_postal_code'), value: (r) => r.postal_code },
      city_col: { label: t('field_city'), value: (r) => r.city },
      country_col: { label: t('field_country'), value: (r) => r.country },
      vat_number_col: { label: t('field_vat_number'), value: (r) => r.vat_number },
      bankgiro_col: { label: t('field_bankgiro'), value: (r) => r.bankgiro },
      plusgiro_col: { label: t('field_plusgiro'), value: (r) => r.plusgiro },
      bank_account_col: { label: t('field_bank_account'), value: (r) => r.bank_account },
      iban_col: { label: t('field_iban'), value: (r) => r.iban },
      bic_col: { label: t('field_bic'), value: (r) => r.bic },
      payment_terms_col: {
        label: t('field_payment_terms'),
        value: (r) => t('days', { count: r.default_payment_terms }),
      },
      default_currency_col: { label: t('field_currency'), value: (r) => r.default_currency },
      notes_col: { label: t('field_notes'), value: (r) => r.notes },
    }),
    [t, tType],
  )
}

export function useArticleReviewFields(): ReviewFields<DetectedArticleColumns, ParsedArticleRow> {
  const t = useTranslations('import_review')
  const tType = useTranslations('articles')
  return useMemo(
    () => ({
      name_col: { label: t('field_article_name'), value: (r) => r.name },
      // No number in the file: the execute route numbers the article on create.
      article_number_col: {
        label: t('field_article_number'),
        value: (r) => r.article_number ?? t('assigned_automatically'),
      },
      type_col: { label: t('field_article_type'), value: (r) => tType(`type_${r.type}`) },
      unit_col: { label: t('field_unit'), value: (r) => r.unit },
      price_col: { label: t('field_price'), value: (r) => formatAmount(r.price_excl_vat) },
      // A file without a currency column imports as SEK.
      currency_col: { label: t('field_currency'), value: (r) => r.currency ?? 'SEK' },
      vat_rate_col: { label: t('field_vat_rate'), value: (r) => `${r.vat_rate} %` },
      revenue_account_col: { label: t('field_revenue_account'), value: (r) => r.revenue_account },
      cost_price_col: {
        label: t('field_cost_price'),
        value: (r) => (r.cost_price === null ? null : formatAmount(r.cost_price)),
      },
      ean_col: { label: t('field_ean'), value: (r) => r.ean },
      housework_type_col: { label: t('field_housework_type'), value: (r) => r.housework_type },
      name_en_col: { label: t('field_article_name_en'), value: (r) => r.name_en },
      notes_col: { label: t('field_notes'), value: (r) => r.notes },
    }),
    [t, tType],
  )
}
