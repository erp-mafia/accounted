'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DetailSection } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import ArticleCombobox from '@/components/invoices/ArticleCombobox'
import { resolveLineVatRates, FALLBACK_VAT_RATE } from '@/components/invoices/line-vat-rates'
import { useArticles, useCustomers } from '@/lib/reference-data/hooks'
import { sortArticles } from '@/lib/articles/sort'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import { roundOre } from '@/lib/money'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatCurrency } from '@/lib/utils'
import { formatQty, todayIso } from '@/components/sales-orders/labels'
import type { Article, SalesOrder, SalesOrderItem, SalesOrderItemInput } from '@/types'

// The invoice editor's currency set (CurrencySchema in lib/api/schemas.ts).
const CURRENCIES = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] as const

// Dense-row cell controls: same vocabulary as the invoice editor's line grid
// (rounded-sm leaves inside the table surface, hairline-free until focus).
const CELL_INPUT_CLASS =
  'h-8 rounded-sm border border-transparent bg-transparent px-2 py-1 text-[13px] transition-colors duration-150 hover:bg-secondary/40 focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/60'
const CELL_SELECT_TRIGGER_CLASS =
  'h-8 w-auto gap-1 rounded-sm border-transparent bg-transparent px-2 py-1 text-[13px] shadow-none hover:bg-secondary/40 tabular-nums'

interface LineState {
  key: string
  id?: string
  line_type: 'product' | 'text'
  description: string
  // Numeric fields are held as strings so the inputs stay controlled while
  // the user types ("1." or "" are valid intermediate states).
  quantity: string
  unit: string
  unit_price: string
  discount_percent: string
  vat_rate: number
  article_id: string | null
  revenue_account: string | null
  // Edit mode: what has already been invoiced on this line (read-only hint).
  invoiced_qty?: number
}

interface SalesOrderFormProps {
  mode: 'create' | 'edit'
  initial?: SalesOrder
}

let keyCounter = 0
function nextKey(): string {
  keyCounter += 1
  return `line-${keyCounter}`
}

function parseNumber(value: string): number {
  const n = parseFloat(value.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function lineFromItem(item: SalesOrderItem): LineState {
  return {
    key: nextKey(),
    id: item.id,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: String(item.quantity),
    unit: item.unit,
    unit_price: String(item.unit_price),
    discount_percent: item.discount_percent > 0 ? String(item.discount_percent) : '',
    vat_rate: item.vat_rate,
    article_id: item.article_id,
    revenue_account: item.revenue_account,
    invoiced_qty: item.invoiced_qty,
  }
}

function blankProductLine(vatRate: number): LineState {
  return {
    key: nextKey(),
    line_type: 'product',
    description: '',
    quantity: '1',
    unit: 'st',
    unit_price: '',
    discount_percent: '',
    vat_rate: vatRate,
    article_id: null,
    revenue_account: null,
  }
}

function blankTextLine(): LineState {
  return {
    key: nextKey(),
    line_type: 'text',
    description: '',
    quantity: '0',
    unit: '',
    unit_price: '0',
    discount_percent: '',
    vat_rate: 0,
    article_id: null,
    revenue_account: null,
  }
}

/**
 * Create/edit form for a kundorder. A lighter sibling of the invoice editor:
 * same customer picker, same article prefill and per-line VAT plan, same
 * line math (computeLineNet), minus everything invoice-only (ROT/RUT,
 * periodisering, payment links). POST on create, PATCH on edit; existing
 * line ids ride along on edit so delivered/invoiced history survives.
 */
export default function SalesOrderForm({ mode, initial }: SalesOrderFormProps) {
  const t = useTranslations('sales_order_form')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()

  const { customers, isLoading: customersLoading } = useCustomers()
  const { articles: articleRows } = useArticles()
  const articles = useMemo(
    () => sortArticles(articleRows.filter((a) => a.active !== false)),
    [articleRows],
  )

  const [customerId, setCustomerId] = useState<string>(initial?.customer_id ?? '')
  const [orderDate, setOrderDate] = useState<string>(initial?.order_date ?? todayIso())
  const [requestedDeliveryDate, setRequestedDeliveryDate] = useState<string>(
    initial?.requested_delivery_date ?? '',
  )
  const [currency, setCurrency] = useState<string>(initial?.currency ?? 'SEK')
  const [yourReference, setYourReference] = useState<string>(initial?.your_reference ?? '')
  const [ourReference, setOurReference] = useState<string>(initial?.our_reference ?? '')
  const [notes, setNotes] = useState<string>(initial?.notes ?? '')
  const [lines, setLines] = useState<LineState[]>(() => {
    const items = [...(initial?.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)
    return items.length > 0 ? items.map(lineFromItem) : [blankProductLine(FALLBACK_VAT_RATE)]
  })
  const [errors, setErrors] = useState<{ customer?: string; lines?: string }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId) ?? null,
    [customers, customerId],
  )
  // The lawful VAT set for the picked customer (0% first for a foreign
  // business); before a customer is picked, the domestic set.
  const vatPlan = useMemo(() => resolveLineVatRates(selectedCustomer), [selectedCustomer])
  const vatOptions = vatPlan.options.length > 0
    ? vatPlan.options
    : resolveLineVatRates({ customer_type: 'swedish_business', vat_number_validated: false }).options

  function updateLine(key: string, patch: Partial<LineState>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev))
  }

  function applyArticle(key: string, value: string) {
    if (value === 'none') {
      updateLine(key, { article_id: null, revenue_account: null })
      return
    }
    const article = articles.find((a) => a.id === value) as Article | undefined
    if (!article) return
    const rateAllowed = vatOptions.some((o) => o.rate === article.vat_rate)
    updateLine(key, {
      article_id: article.id,
      description: article.name,
      unit: article.unit,
      unit_price: String(article.price_excl_vat),
      vat_rate: rateAllowed ? article.vat_rate : vatPlan.defaultRate,
      revenue_account: article.revenue_account,
    })
  }

  function handleCustomerChange(nextId: string) {
    const previousDefault = vatPlan.defaultRate
    setCustomerId(nextId)
    const nextCustomer = customers.find((c) => c.id === nextId) ?? null
    const nextDefault = resolveLineVatRates(nextCustomer).defaultRate
    // Only lines still on the previous default follow the customer switch;
    // an explicitly chosen rate is left alone (same rule as the invoice editor).
    if (nextDefault !== previousDefault) {
      setLines((prev) =>
        prev.map((l) =>
          l.line_type === 'product' && l.vat_rate === previousDefault
            ? { ...l, vat_rate: nextDefault }
            : l,
        ),
      )
    }
  }

  // Client-side totals, same öre-exact formulas as the server.
  const totals = useMemo(() => {
    let subtotal = 0
    let vat = 0
    for (const l of lines) {
      if (l.line_type === 'text') continue
      const net = computeLineNet(
        parseNumber(l.quantity),
        parseNumber(l.unit_price),
        l.discount_percent ? parseNumber(l.discount_percent) : null,
      )
      subtotal = roundOre(subtotal + net)
      vat = roundOre(vat + roundOre((net * l.vat_rate) / 100))
    }
    return { subtotal, vat, total: roundOre(subtotal + vat) }
  }, [lines])

  function lineNet(l: LineState): number {
    if (l.line_type === 'text') return 0
    return computeLineNet(
      parseNumber(l.quantity),
      parseNumber(l.unit_price),
      l.discount_percent ? parseNumber(l.discount_percent) : null,
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const nextErrors: { customer?: string; lines?: string } = {}
    if (!customerId) nextErrors.customer = t('validation_customer_required')
    const productLines = lines.filter((l) => l.line_type === 'product')
    if (productLines.length === 0 || productLines.some((l) => !l.description.trim())) {
      nextErrors.lines = t('validation_lines_required')
    }
    setErrors(nextErrors)
    if (nextErrors.customer || nextErrors.lines) return

    const items: SalesOrderItemInput[] = lines.map((l) => ({
      ...(l.id ? { id: l.id } : {}),
      line_type: l.line_type,
      description: l.description,
      quantity: l.line_type === 'text' ? 0 : parseNumber(l.quantity),
      unit: l.line_type === 'text' ? '' : l.unit,
      unit_price: l.line_type === 'text' ? 0 : parseNumber(l.unit_price),
      discount_percent:
        l.line_type === 'text' || !l.discount_percent ? null : parseNumber(l.discount_percent),
      vat_rate: l.line_type === 'text' ? 0 : l.vat_rate,
      article_id: l.article_id,
      revenue_account: l.revenue_account,
    }))

    const body = {
      customer_id: customerId,
      order_date: orderDate,
      requested_delivery_date: requestedDeliveryDate || null,
      currency,
      your_reference: yourReference.trim() || null,
      our_reference: ourReference.trim() || null,
      notes: notes.trim() || null,
      items,
    }

    setIsSubmitting(true)
    try {
      const url = mode === 'edit' && initial ? `/api/sales-orders/${initial.id}` : '/api/sales-orders'
      const response = await fetch(url, {
        method: mode === 'edit' ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok) {
        toast({
          title: mode === 'edit' ? t('update_failed_title') : t('create_failed_title'),
          description: getErrorMessage(json, { locale: errorLocale, statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      const order = json?.data as SalesOrder
      toast({
        title:
          mode === 'edit'
            ? t('updated_title')
            : t('created_title', { number: order.order_number ?? '' }),
      })
      router.push(`/sales-orders/${order.id}`)
    } catch (err) {
      toast({
        title: mode === 'edit' ? t('update_failed_title') : t('create_failed_title'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8" noValidate>
      <DetailSection kicker={t('section_customer')}>
        <div className="max-w-md">
          <Select value={customerId} onValueChange={handleCustomerChange}>
            <SelectTrigger className="h-12 font-display text-base" aria-required="true" aria-invalid={errors.customer ? true : undefined}>
              <SelectValue placeholder={t('select_customer_placeholder')} />
            </SelectTrigger>
            <SelectContent>
              {customers.length === 0 && (
                <div className="px-3 py-2 text-[13px] text-muted-foreground">
                  {customersLoading ? t('loading_customers') : t('no_customers_yet')}
                </div>
              )}
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={customer.id}>
                  {customer.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.customer && <p className="mt-2 text-sm text-destructive">{errors.customer}</p>}
        </div>
      </DetailSection>

      <DetailSection kicker={t('section_details')}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="so-order-date">{t('order_date_label')}</Label>
            <Input
              id="so-order-date"
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              className="tabular-nums"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-delivery-date">{t('requested_delivery_date_label')}</Label>
            <Input
              id="so-delivery-date"
              type="date"
              value={requestedDeliveryDate}
              onChange={(e) => setRequestedDeliveryDate(e.target.value)}
              className="tabular-nums"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-currency">{t('currency_label')}</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id="so-currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-your-ref">{t('your_reference_label')}</Label>
            <Input
              id="so-your-ref"
              value={yourReference}
              onChange={(e) => setYourReference(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="so-our-ref">{t('our_reference_label')}</Label>
            <Input
              id="so-our-ref"
              value={ourReference}
              onChange={(e) => setOurReference(e.target.value)}
              maxLength={200}
            />
          </div>
          <div className="space-y-2 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="so-notes">{t('notes_label')}</Label>
            <Textarea
              id="so-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={4000}
            />
          </div>
        </div>
      </DetailSection>

      <DetailSection kicker={t('section_lines')}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'pl-0')}>{t('th_description')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_quantity')}</th>
                <th className={TH_CLASS}>{t('th_unit')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_unit_price')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_discount')}</th>
                <th className={TH_CLASS}>{t('th_vat')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                <th className={cn(TH_CLASS, 'pr-0')}>
                  <span className="sr-only">{t('remove_row')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const isText = line.line_type === 'text'
                return (
                  <tr key={line.key} className="align-top">
                    <td className={cn(TD_CLASS, 'pl-0')}>
                      {isText ? (
                        <Input
                          value={line.description}
                          onChange={(e) => updateLine(line.key, { description: e.target.value })}
                          placeholder={t('text_row_placeholder')}
                          aria-label={t('th_description')}
                          className={cn(CELL_INPUT_CLASS, 'w-full min-w-[16rem] text-muted-foreground')}
                          maxLength={2000}
                        />
                      ) : (
                        <div className="min-w-[16rem] space-y-1">
                          <Input
                            value={line.description}
                            onChange={(e) => updateLine(line.key, { description: e.target.value })}
                            placeholder={t('description_placeholder')}
                            aria-label={t('th_description')}
                            className={cn(CELL_INPUT_CLASS, 'w-full')}
                            maxLength={2000}
                          />
                          {articles.length > 0 && (
                            <div className="max-w-xs">
                              <ArticleCombobox
                                value={line.article_id}
                                articles={articles}
                                onChange={(v) => applyArticle(line.key, v)}
                                freeTextLabel={t('article_free_text')}
                                placeholder={t('article_placeholder')}
                                emptyLabel={t('article_search_empty')}
                                ariaLabel={t('article_label')}
                              />
                            </div>
                          )}
                          {typeof line.invoiced_qty === 'number' && line.invoiced_qty > 0 && (
                            <p className="px-2 text-xs text-muted-foreground tabular-nums">
                              {t('invoiced_hint', { qty: formatQty(line.invoiced_qty) })}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right')}>
                      {!isText && (
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min={0}
                          value={line.quantity}
                          onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                          aria-label={t('th_quantity')}
                          className={cn(CELL_INPUT_CLASS, 'w-20 text-right tabular-nums')}
                        />
                      )}
                    </td>
                    <td className={TD_CLASS}>
                      {!isText && (
                        <Input
                          value={line.unit}
                          onChange={(e) => updateLine(line.key, { unit: e.target.value })}
                          aria-label={t('th_unit')}
                          className={cn(CELL_INPUT_CLASS, 'w-16')}
                          maxLength={32}
                        />
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right')}>
                      {!isText && (
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          value={line.unit_price}
                          onChange={(e) => updateLine(line.key, { unit_price: e.target.value })}
                          aria-label={t('th_unit_price')}
                          className={cn(CELL_INPUT_CLASS, 'w-28 text-right tabular-nums')}
                        />
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'text-right')}>
                      {!isText && (
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          min={0}
                          max={100}
                          value={line.discount_percent}
                          onChange={(e) => updateLine(line.key, { discount_percent: e.target.value })}
                          aria-label={t('th_discount')}
                          className={cn(CELL_INPUT_CLASS, 'w-20 text-right tabular-nums')}
                        />
                      )}
                    </td>
                    <td className={TD_CLASS}>
                      {!isText && (
                        <Select
                          value={String(line.vat_rate)}
                          onValueChange={(v) => updateLine(line.key, { vat_rate: Number(v) })}
                          disabled={vatPlan.isPickerLocked}
                        >
                          <SelectTrigger className={CELL_SELECT_TRIGGER_CLASS} aria-label={t('th_vat')}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {vatOptions.map((opt) => (
                              <SelectItem key={opt.rate} value={String(opt.rate)}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {!isText && formatCurrency(lineNet(line), currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'pr-0 text-right')}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeLine(line.key)}
                        disabled={lines.length <= 1}
                        aria-label={t('remove_row')}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {errors.lines && <p className="mt-2 text-sm text-destructive">{errors.lines}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((prev) => [...prev, blankProductLine(vatPlan.defaultRate)])}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('add_row')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setLines((prev) => [...prev, blankTextLine()])}
            className="text-muted-foreground"
          >
            {t('add_text_row')}
          </Button>
        </div>

        <div className="mt-6 ml-auto w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('subtotal')}</span>
            <span className="tabular-nums">{formatCurrency(totals.subtotal, currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('vat')}</span>
            <span className="tabular-nums">{formatCurrency(totals.vat, currency)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2">
            <span>{t('total')}</span>
            <span className="font-display text-xl tabular-nums">{formatCurrency(totals.total, currency)}</span>
          </div>
        </div>
      </DetailSection>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={isSubmitting}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {mode === 'edit' ? t('submit_edit') : t('submit_create')}
        </Button>
      </div>
    </form>
  )
}
