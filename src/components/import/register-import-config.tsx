'use client'

import { useMemo, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ExclamationTriangleIcon } from '@/components/icons'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { parseAmountInput } from '@/lib/money'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import type { RegisterImportEntity } from '@/lib/import/register-import-link'
import type { RegisterColumnSpec } from '@/components/import/RegisterColumnMappingStep'
import {
  useArticleReviewFields,
  useCustomerReviewFields,
  useSupplierReviewFields,
  type ReviewField,
} from '@/components/import/register-review-fields'
import type { AnnotatedCustomerRow } from '@/lib/import/customers/types'
import type { AnnotatedSupplierRow } from '@/lib/import/suppliers/types'
import type { AnnotatedArticleRow, DetectedArticleColumns } from '@/lib/import/articles/types'
import { parseArticleFileInBrowser, type ArticleBrowserParseOutcome } from '@/lib/import/articles/browser-parse'

/**
 * What differs between the register imports (Kunder, Leverantörer,
 * Artiklar). The wizard (RegisterImportFlow) and its review step
 * (RegisterEditStep) are one component each; everything a register needs of
 * its own is a value here.
 */

/** What the review step reads off every register's rows. */
export interface ReviewRow {
  name: string
  /** The row's line in the file (the header is line 1). */
  row_index?: number
  is_valid: boolean
  validation_errors: string[]
  duplicate_match: { existing_name: string; matched_by: string } | null
  possible_duplicate?: { existing_name: string } | null
  confirmed_duplicate_of?: string | null
}

/** One column of the review table besides status and the row actions. */
export interface EditColumn<R> {
  key: string
  header: string
  /** The header cell's width and alignment. */
  headClassName?: string
  /** The body cell's class, besides the shared padding. */
  cellClassName?: string
  cell(row: R, update: (updates: Partial<R>) => void): ReactNode
}

export interface RegisterImportConfig<R extends ReviewRow = ReviewRow> {
  entity: RegisterImportEntity
  /** The mapping step's fields, in display order. */
  columnSpecs: RegisterColumnSpec<string>[]
  /** Fields the parse route adds for review only, beyond REVIEW_ONLY_FIELDS. */
  executeReviewOnly: readonly string[]
  reviewFields: Readonly<Record<string, ReviewField<R>>>
  columns: EditColumn<R>[]
  /** Registers that ask about same-name rows: the party and the existing record's id. */
  possibleDuplicate: { party: 'customer' | 'supplier'; existingId(row: R): string | null } | null
  /** Notices the review step derives from the rows, and the parser notices those replace. */
  rowNotices?(rows: R[], parserNotices: ImportNotice[]): ImportNotice[]
  /**
   * Registers whose file is read in the browser instead of posted to the
   * parse route (articles: a supplier price list outgrows what the host
   * carries, crm#1383). Answers the parse route's shape.
   */
  parseInBrowser?(file: File, overrides: Record<string, number | null> | undefined): Promise<ArticleBrowserParseOutcome>
}

const CUSTOMER_COLUMN_SPECS = (customerNumberLabel: string): RegisterColumnSpec<string>[] => [
  { key: 'name_col', label: 'Namn', required: true },
  { key: 'customer_number_col', label: customerNumberLabel, required: false },
  { key: 'org_number_col', label: 'Org-/personnummer', required: false },
  { key: 'customer_type_col', label: 'Kundtyp', required: false },
  { key: 'email_col', label: 'E-post', required: false },
  { key: 'phone_col', label: 'Telefon', required: false },
  { key: 'address_line1_col', label: 'Adress', required: false },
  { key: 'address_line2_col', label: 'Adress rad 2', required: false },
  { key: 'postal_code_col', label: 'Postnummer', required: false },
  { key: 'city_col', label: 'Ort', required: false },
  { key: 'country_col', label: 'Land', required: false },
  { key: 'vat_number_col', label: 'VAT-nummer', required: false },
  { key: 'payment_terms_col', label: 'Betalningsvillkor (dagar)', required: false },
  { key: 'notes_col', label: 'Anteckning', required: false },
]

const SUPPLIER_COLUMN_SPECS: RegisterColumnSpec<string>[] = [
  { key: 'name_col', label: 'Namn', required: true },
  { key: 'org_number_col', label: 'Org-/personnummer', required: false },
  { key: 'supplier_type_col', label: 'Leverantörstyp', required: false },
  { key: 'email_col', label: 'E-post', required: false },
  { key: 'phone_col', label: 'Telefon', required: false },
  { key: 'address_line1_col', label: 'Adress', required: false },
  { key: 'address_line2_col', label: 'Adress rad 2', required: false },
  { key: 'postal_code_col', label: 'Postnummer', required: false },
  { key: 'city_col', label: 'Ort', required: false },
  { key: 'country_col', label: 'Land', required: false },
  { key: 'vat_number_col', label: 'VAT-nummer', required: false },
  { key: 'bankgiro_col', label: 'Bankgiro', required: false },
  { key: 'plusgiro_col', label: 'Plusgiro', required: false },
  { key: 'bank_account_col', label: 'Bankkonto', required: false },
  { key: 'iban_col', label: 'IBAN', required: false },
  { key: 'bic_col', label: 'BIC/SWIFT', required: false },
  { key: 'payment_terms_col', label: 'Betalningsvillkor (dagar)', required: false },
  { key: 'default_currency_col', label: 'Valuta', required: false },
  { key: 'notes_col', label: 'Anteckning', required: false },
]

const ARTICLE_COLUMN_SPECS: RegisterColumnSpec<string>[] = [
  { key: 'name_col', label: 'Benämning', required: true },
  { key: 'article_number_col', label: 'Artikelnummer', required: false },
  { key: 'type_col', label: 'Typ (vara/tjänst)', required: false },
  { key: 'unit_col', label: 'Enhet', required: false },
  { key: 'price_col', label: 'Pris exkl moms', required: false },
  { key: 'currency_col', label: 'Valuta', required: false },
  { key: 'vat_rate_col', label: 'Moms (%)', required: false },
  { key: 'revenue_account_col', label: 'Försäljningskonto', required: false },
  { key: 'cost_price_col', label: 'Inköpspris', required: false },
  { key: 'ean_col', label: 'EAN', required: false },
  { key: 'housework_type_col', label: 'ROT/RUT-arbetstyp', required: false },
  { key: 'name_en_col', label: 'Benämning (engelska)', required: false },
  { key: 'notes_col', label: 'Anteckning', required: false },
]

const VAT_RATES = [25, 12, 6, 0] as const

const MUTED_CELL = 'text-muted-foreground tabular-nums'

function nameColumn<R extends ReviewRow>(header: string): EditColumn<R> {
  return {
    key: 'name',
    header,
    cell: (row, update) => (
      <Input
        value={row.name}
        onChange={(e) => update({ name: e.target.value } as Partial<R>)}
        className="h-8"
      />
    ),
  }
}

/** The register's type as an inline select, labelled from its own namespace. */
function typeColumn<R extends ReviewRow>(
  header: string,
  headClassName: string,
  field: keyof R & string,
  options: readonly { value: string; label: string }[],
): EditColumn<R> {
  return {
    key: field,
    header,
    headClassName,
    cell: (row, update) => (
      <Select
        value={String(row[field])}
        onValueChange={(v) => update({ [field]: v } as Partial<R>)}
      >
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ),
  }
}

/** The register's import config, for the register the wizard has open. */
export function useRegisterImportConfig(entity: RegisterImportEntity): RegisterImportConfig {
  const t = useTranslations('import.register_edit')
  const tCustomers = useTranslations('customers')
  const tSuppliers = useTranslations('suppliers')
  const tArticles = useTranslations('articles')
  const tCustomerForm = useTranslations('form_customer')
  const customerFields = useCustomerReviewFields()
  const supplierFields = useSupplierReviewFields()
  const articleFields = useArticleReviewFields()

  return useMemo((): RegisterImportConfig => {
    if (entity === 'customers') {
      const config: RegisterImportConfig<AnnotatedCustomerRow> = {
        entity,
        columnSpecs: CUSTOMER_COLUMN_SPECS(tCustomerForm('customer_number_label')),
        executeReviewOnly: [],
        reviewFields: customerFields,
        possibleDuplicate: {
          party: 'customer',
          existingId: (row) => row.possible_duplicate?.customer_id ?? null,
        },
        columns: [
          {
            key: 'customer_number',
            header: tCustomers('col_customer_number'),
            headClassName: 'w-24',
            cellClassName: MUTED_CELL,
            cell: (row) => row.customer_number || '-',
          },
          nameColumn(t('col_name')),
          typeColumn(
            t('col_customer_type'),
            'w-44',
            'customer_type',
            (['individual', 'swedish_business', 'eu_business', 'non_eu_business'] as const).map((v) => ({
              value: v,
              label: tCustomers(`type_${v}`),
            })),
          ),
          {
            key: 'org_number',
            header: t('col_org_number'),
            headClassName: 'w-36',
            cellClassName: MUTED_CELL,
            cell: (row) => row.org_number || '-',
          },
          {
            key: 'email',
            header: t('col_email'),
            cellClassName: 'text-muted-foreground truncate max-w-xs',
            cell: (row) => row.email || '-',
          },
        ],
      }
      return config as unknown as RegisterImportConfig
    }

    if (entity === 'suppliers') {
      const config: RegisterImportConfig<AnnotatedSupplierRow> = {
        entity,
        columnSpecs: SUPPLIER_COLUMN_SPECS,
        executeReviewOnly: [],
        reviewFields: supplierFields,
        possibleDuplicate: {
          party: 'supplier',
          existingId: (row) => row.possible_duplicate?.supplier_id ?? null,
        },
        columns: [
          nameColumn(t('col_name')),
          typeColumn(
            t('col_type'),
            'w-44',
            'supplier_type',
            (['swedish_business', 'eu_business', 'non_eu_business'] as const).map((v) => ({
              value: v,
              label: tSuppliers(`type_${v}`),
            })),
          ),
          {
            key: 'org_number',
            header: t('col_org_number'),
            headClassName: 'w-36',
            cellClassName: MUTED_CELL,
            cell: (row) => row.org_number || '-',
          },
          {
            key: 'bank',
            header: t('col_bank'),
            headClassName: 'w-32',
            cellClassName: `${MUTED_CELL} truncate max-w-[10rem]`,
            cell: (row) => row.bankgiro || row.plusgiro || row.iban || '-',
          },
        ],
      }
      return config as unknown as RegisterImportConfig
    }

    const config: RegisterImportConfig<AnnotatedArticleRow> = {
      entity,
      columnSpecs: ARTICLE_COLUMN_SPECS,
      // The parser's VAT reinterpretation marker is for the review step only.
      executeReviewOnly: ['vat_rate_adjusted'],
      reviewFields: articleFields,
      possibleDuplicate: null,
      parseInBrowser: (file, overrides) =>
        parseArticleFileInBrowser(file, overrides as DetectedArticleColumns | undefined),
      columns: [
        {
          key: 'article_number',
          header: t('col_article_number'),
          headClassName: 'w-28',
          cellClassName: MUTED_CELL,
          cell: (row) => row.article_number || t('article_number_auto'),
        },
        nameColumn(t('col_article_name')),
        typeColumn(
          t('col_type'),
          'w-28',
          'type',
          (['vara', 'tjanst'] as const).map((v) => ({ value: v, label: tArticles(`type_${v}`) })),
        ),
        {
          key: 'price',
          header: t('col_price'),
          headClassName: 'text-right w-28',
          cell: (row, update) => (
            <div className="flex items-center gap-1.5">
              <Input
                value={String(row.price_excl_vat)}
                inputMode="decimal"
                onChange={(e) => {
                  const price = parseAmountInput(e.target.value) ?? 0
                  update({
                    price_excl_vat: price,
                    is_valid: price >= 0,
                    validation_errors: price < 0 ? [t('price_negative')] : [],
                  })
                }}
                className="h-8 text-right tabular-nums"
              />
              {/* Exception chip: only non-SEK rows carry a marker. */}
              {row.currency && row.currency !== 'SEK' && (
                <span className="shrink-0 text-xs text-muted-foreground">{row.currency}</span>
              )}
            </div>
          ),
        },
        {
          key: 'vat_rate',
          header: t('col_vat'),
          headClassName: 'w-24',
          cell: (row, update) => (
            <div className="flex items-center gap-1.5">
              <Select
                value={String(row.vat_rate)}
                onValueChange={(v) => update({ vat_rate: Number(v), vat_rate_adjusted: false })}
              >
                <SelectTrigger className={cn('h-8', row.vat_rate_adjusted && 'border-border text-warning')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VAT_RATES.map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r} %
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {row.vat_rate_adjusted && (
                <span className="text-warning shrink-0" title={t('vat_adjusted_title')}>
                  <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                </span>
              )}
            </div>
          ),
        },
      ],
      // A VAT-inclusive price column or reinterpreted rates: one sentence for
      // the rows, which replaces the parser's rounding notice.
      rowNotices: (rows, parserNotices) => {
        const adjusted = rows.filter((r) => r.vat_rate_adjusted).length
        return [
          ...(adjusted > 0 ? [makeNotice('vat_reinterpreted', 'action', { count: adjusted })] : []),
          ...parserNotices.filter((n) => n.code !== 'articles_vat_rounded' || adjusted === 0),
        ]
      },
    }
    return config as unknown as RegisterImportConfig
  }, [entity, t, tCustomers, tSuppliers, tArticles, tCustomerForm, customerFields, supplierFields, articleFields])
}
