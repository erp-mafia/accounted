'use client'

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { Plus, Package, Lock, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { EmptyState } from '@/components/ui/empty-state'
import { ContextPicker } from '@/components/common/ContextPicker'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { cn, formatCurrency } from '@/lib/utils'
import { compareArticles } from '@/lib/articles/sort'
import {
  ALL_CURRENCIES,
  listArticleCurrencies,
  matchesCurrencyScope,
  resolveCurrencyScope,
} from '@/lib/articles/currency-scope'
import Link from 'next/link'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Article, ArticleType, CreateArticleInput } from '@/types'

const ArticleForm = dynamic(
  () => import('@/components/articles/ArticleForm'),
  {
    loading: () => (
      <div className="space-y-4 py-4" role="status">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    ),
  },
)

const ARTICLE_TYPE_LABEL_KEYS: Record<ArticleType, string> = {
  vara: 'type_vara',
  tjanst: 'type_tjanst',
}

type SortColumn = 'name' | 'article_number' | 'type' | 'unit' | 'price_excl_vat' | 'vat_rate'
type SortDir = 'asc' | 'desc'

const SORTABLE_COLUMNS: ReadonlyArray<SortColumn> = [
  'name',
  'article_number',
  'type',
  'unit',
  'price_excl_vat',
  'vat_rate',
]
const INITIAL_VISIBLE_ROWS = 100

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'sv', { sensitivity: 'base' })
}

function ArticlesPageInner() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const [articles, setArticles] = useState<Article[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('articles')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const sortParam = searchParams.get('sort')
  const dirParam = searchParams.get('dir')
  // Currency scope (#1189). In the URL like the sort, so a filtered register
  // survives opening an article and coming back, and can be linked to.
  const currencyParam = searchParams.get('currency')
  // Default to the user's own article numbering (numeric-aware), issue #1053.
  const sortColumn: SortColumn = (SORTABLE_COLUMNS as ReadonlyArray<string>).includes(sortParam ?? '')
    ? (sortParam as SortColumn)
    : 'article_number'
  const sortDir: SortDir = dirParam === 'desc' ? 'desc' : 'asc'

  const updateSort = useCallback(
    (column: SortColumn) => {
      setVisibleCount(INITIAL_VISIBLE_ROWS)
      const params = new URLSearchParams(searchParams.toString())
      let nextDir: SortDir = 'asc'
      if (column === sortColumn) {
        nextDir = sortDir === 'asc' ? 'desc' : 'asc'
      }
      params.set('sort', column)
      params.set('dir', nextDir)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [searchParams, sortColumn, sortDir, router, pathname]
  )

  async function fetchArticles() {
    if (!company) return
    setIsLoading(true)
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (error) {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } else {
      setArticles(data || [])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchArticles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Create runs through useSubmitWithAccountActivation so an ACCOUNTS_NOT_IN_CHART
  // response (revenue account not yet activated) opens the standard
  // activate-and-retry dialog instead of failing: same UX as the journal entry form.
  const pendingCreateRef = useRef<CreateArticleInput | null>(null)
  const submitCreate = useCallback(async () => {
    const response = await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingCreateRef.current),
    })
    return (await throwOnStructuredError(response)) as { data: Article }
  }, [])
  const {
    runSubmit: runCreate,
    dialog: activationDialog,
    confirm: confirmActivation,
    cancel: cancelActivation,
  } = useSubmitWithAccountActivation(submitCreate)

  async function handleCreateArticle(data: CreateArticleInput) {
    setIsCreating(true)
    pendingCreateRef.current = data
    try {
      const result = await runCreate()
      toast({
        title: t('created_title'),
        description: t('created_description', { name: data.name }),
      })
      setArticles([...articles, result.data])
      setIsDialogOpen(false)
    } catch (err) {
      // The user closing the activation dialog is not an error worth toasting.
      if (!(err instanceof Error && err.message === 'cancelled')) {
        const body = (err as { body?: unknown }).body
        toast({
          title: t('create_failed_title'),
          description: getErrorMessage(body ?? err, { context: 'article', locale: errorLocale }),
          variant: 'destructive',
        })
      }
    } finally {
      setIsCreating(false)
    }
  }

  const availableCurrencies = useMemo(() => listArticleCurrencies(articles), [articles])
  const currencyFilter = resolveCurrencyScope(currencyParam, availableCurrencies)

  const updateCurrencyFilter = useCallback(
    (next: string) => {
      setVisibleCount(INITIAL_VISIBLE_ROWS)
      const params = new URLSearchParams(searchParams.toString())
      if (next === ALL_CURRENCIES) params.delete('currency')
      else params.set('currency', next)
      const query = params.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [searchParams, router, pathname],
  )

  const filteredArticles = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term && currencyFilter === ALL_CURRENCIES) return articles
    return articles.filter((a) => {
      if (!matchesCurrencyScope(a, currencyFilter)) return false
      if (!term) return true
      return (
        a.name.toLowerCase().includes(term) ||
        a.name_en?.toLowerCase().includes(term) ||
        a.article_number?.toLowerCase().includes(term)
      )
    })
  }, [articles, searchTerm, currencyFilter])

  const sortedArticles = useMemo(() => {
    const arr = [...filteredArticles]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortColumn) {
        case 'price_excl_vat':
          cmp = a.price_excl_vat - b.price_excl_vat
          break
        case 'vat_rate':
          cmp = a.vat_rate - b.vat_rate
          break
        case 'name':
          cmp = compareStrings(a.name || '', b.name || '')
          break
        case 'article_number':
          cmp = compareArticles(a, b)
          break
        case 'type':
          cmp = compareStrings(a.type || '', b.type || '')
          break
        case 'unit':
          cmp = compareStrings(a.unit || '', b.unit || '')
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filteredArticles, sortColumn, sortDir])
  const visibleArticles = sortedArticles.slice(0, visibleCount)

  // Sortable dry-table head: the button inherits the TH typography and only
  // adds the direction affordance.
  function SortableTh({
    column,
    label,
    className,
  }: {
    column: SortColumn
    label: string
    className?: string
  }) {
    const isActive = sortColumn === column
    const Icon = isActive ? (sortDir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown
    return (
      <th className={cn(TH_CLASS, className)}>
        <button
          type="button"
          onClick={() => updateSort(column)}
          className="inline-flex items-center gap-1 transition-colors duration-150 hover:text-foreground"
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </th>
    )
  }

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 27): title + export + Ny artikel */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex items-center gap-2">
          <ReportExportMenu
            size="default"
            items={[
              { format: 'xlsx', href: '/api/export/articles' },
              { format: 'csv', href: '/api/export/articles?format=csv' },
            ]}
          />
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                disabled={!canWrite}
                title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
              >
                {canWrite ? (
                  <Plus className="mr-2 h-4 w-4" />
                ) : (
                  <Lock className="mr-2 h-4 w-4" />
                )}
                {t('new_article')}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t('add_article')}</DialogTitle>
              </DialogHeader>
              <ArticleForm
                onSubmit={handleCreateArticle}
                isLoading={isCreating}
                onCancel={() => setIsDialogOpen(false)}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Toolbar: search, plus the currency scope far right (convention 8) */}
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarSearch
          containerClassName="min-w-[190px]"
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value)
            setVisibleCount(INITIAL_VISIBLE_ROWS)
          }}
        />
        {/* A single-currency register needs no scope: the chip would be a
            control with one meaningful position. */}
        {availableCurrencies.length > 1 && (
          <ContextPicker
            className="ml-auto"
            ariaLabel={t('currency_filter_aria')}
            value={currencyFilter}
            onChange={updateCurrencyFilter}
            triggerLabel={
              currencyFilter === ALL_CURRENCIES
                ? t('currency_filter_all')
                : t('currency_filter_selected', { currency: currencyFilter })
            }
            items={[
              { id: ALL_CURRENCIES, label: t('currency_filter_all') },
              ...availableCurrencies.map((code) => ({ id: code, label: code })),
            ]}
          />
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : sortedArticles.length === 0 ? (
        searchTerm ? (
          <EmptyState
            icon={Package}
            title={t('no_search_results_title')}
            description={
              // The currency scope is part of why nothing matched, so it has to
              // be named: otherwise the register reads as empty of the term
              // when it is only empty inside the active scope.
              // data-ph-mask: the search term is what the user typed.
              <span data-ph-mask="">
                {currencyFilter === ALL_CURRENCIES
                  ? t('no_search_results_description', { term: searchTerm })
                  : t('no_search_results_in_currency_description', {
                      term: searchTerm,
                      currency: currencyFilter,
                    })}
              </span>
            }
          />
        ) : (
          <EmptyState
            icon={Package}
            title={t('empty_title')}
            description={t('empty_description')}
            actionLabel={canWrite ? t('empty_action') : undefined}
            onAction={canWrite ? () => setIsDialogOpen(true) : undefined}
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <SortableTh column="article_number" label={t('col_number')} />
                  <SortableTh column="name" label={t('col_name')} className="w-full" />
                  <SortableTh column="type" label={t('col_type')} className="hidden md:table-cell" />
                  <SortableTh column="unit" label={t('col_unit')} className="hidden text-right sm:table-cell" />
                  <SortableTh column="price_excl_vat" label={t('col_price')} className="text-right" />
                  <SortableTh column="vat_rate" label={t('col_vat')} className="hidden text-right sm:table-cell" />
                  <th className={cn(TH_CLASS, 'text-right')}>{t('col_status')}</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {visibleArticles.map((article) => (
                  <tr
                    key={article.id}
                    className="group cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
                    onClick={() => router.push(`/articles/${article.id}`)}
                  >
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                      {article.article_number || '-'}
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <Link
                        href={`/articles/${article.id}`}
                        className="block truncate hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {article.name}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground md:table-cell')}>
                      {t(ARTICLE_TYPE_LABEL_KEYS[article.type])}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right text-muted-foreground sm:table-cell')}>
                      {article.unit}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
                      {formatCurrency(article.price_excl_vat, article.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                      {article.vat_rate} %
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                      {article.active ? (
                        <span className="text-muted-foreground">{t('status_active')}</span>
                      ) : (
                        <Badge variant="outline" className="font-normal">
                          {t('status_inactive')}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer count (concept pgnote) */}
          <p className="px-1 text-xs text-muted-foreground tabular-nums">
            {t('count_footer', { count: sortedArticles.length })}
          </p>

          {visibleCount < sortedArticles.length && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_ROWS)}
              >
                {tCommon('load_more')}
              </Button>
            </div>
          )}
        </>
      )}

      <ActivateAccountsDialog
        open={activationDialog.open}
        accountNumbers={activationDialog.accountNumbers}
        onConfirm={confirmActivation}
        onCancel={cancelActivation}
        confirmLabel={t('activate_and_save')}
      />
    </div>
  )
}

export default function ArticlesPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-10 w-32" />
          </div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      }
    >
      <ArticlesPageInner />
    </Suspense>
  )
}
