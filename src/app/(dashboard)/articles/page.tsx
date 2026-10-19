'use client'

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react'
import dynamic from 'next/dynamic'
import { useLocale, useTranslations } from 'next-intl'
import { useArticles } from '@/lib/reference-data/hooks'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { TD_CLASS, SHOW_MORE_STEP, ShowMoreFooter, SortableTh } from '@/components/ui/dry-table'
import { useUrlSort } from '@/lib/hooks/use-url-sort'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { Plus, Package, Lock } from 'lucide-react'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { EmptyState } from '@/components/ui/empty-state'
import { ContextPicker } from '@/components/common/ContextPicker'
import { RegisterActionsMenu } from '@/components/import/RegisterActionsMenu'
import { cn, formatCurrency } from '@/lib/utils'
import { compareArticles } from '@/lib/articles/sort'
import {
  ALL_CURRENCIES,
  listArticleCurrencies,
  matchesCurrencyScope,
  resolveCurrencyScope,
} from '@/lib/articles/currency-scope'
import Link from 'next/link'
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

const SORTABLE_COLUMNS: ReadonlyArray<SortColumn> = [
  'name',
  'article_number',
  'type',
  'unit',
  'price_excl_vat',
  'vat_rate',
]

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'sv', { sensitivity: 'base' })
}

function ArticlesPageInner() {
  const { canWrite } = useCanWrite()
  // The register from the session cache (lib/reference-data), inactive
  // articles included; /api/articles pages past PostgREST's 1000-row cap,
  // which the direct select here did not. A create refreshes every picker.
  const { articles, isLoading, error: articlesError } = useArticles({ includeInactive: true })
  const [searchTerm, setSearchTerm] = useState('')
  const [visibleCount, setVisibleCount] = useState(SHOW_MORE_STEP)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const t = useTranslations('articles')
  const errorLocale = useLocale() as ErrorLocale

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Currency scope (#1189). In the URL like the sort, so a filtered register
  // survives opening an article and coming back, and can be linked to.
  const currencyParam = searchParams.get('currency')
  // Default to the user's own article numbering (numeric-aware), issue #1053.
  const resetVisible = useCallback(() => setVisibleCount(SHOW_MORE_STEP), [])
  const { column: sortColumn, direction: sortDir, toggle: updateSort } = useUrlSort(
    SORTABLE_COLUMNS,
    'article_number',
    resetVisible,
  )

  useEffect(() => {
    if (!articlesError) return
    toast({
      title: t('load_failed_title'),
      description: t('load_failed_description'),
      variant: 'destructive',
    })
  }, [articlesError, toast, t])

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
      await runCreate()
      toast({
        title: t('created_title'),
        description: t('created_description', { name: data.name }),
      })
      await invalidateReferenceData('ref:articles')
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
      setVisibleCount(SHOW_MORE_STEP)
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

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 27): title + import/export menu + Ny artikel */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <RegisterActionsMenu entity="articles" />
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
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
            setVisibleCount(SHOW_MORE_STEP)
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
                  <SortableTh direction={sortColumn === 'article_number' ? sortDir : null} onSort={() => updateSort('article_number')} label={t('col_number')} />
                  <SortableTh direction={sortColumn === 'name' ? sortDir : null} onSort={() => updateSort('name')} label={t('col_name')} className="w-full" />
                  <SortableTh direction={sortColumn === 'type' ? sortDir : null} onSort={() => updateSort('type')} label={t('col_type')} className="hidden md:table-cell" />
                  <SortableTh direction={sortColumn === 'unit' ? sortDir : null} onSort={() => updateSort('unit')} label={t('col_unit')} className="hidden text-right sm:table-cell" />
                  <SortableTh direction={sortColumn === 'price_excl_vat' ? sortDir : null} onSort={() => updateSort('price_excl_vat')} label={t('col_price')} className="text-right" />
                  <SortableTh direction={sortColumn === 'vat_rate' ? sortDir : null} onSort={() => updateSort('vat_rate')} label={t('col_vat')} className="hidden text-right sm:table-cell" />
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
                    {/* Active is the normal state and says nothing; an inactive
                        article carries a muted suffix after its name. */}
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <span className="flex min-w-0 items-baseline gap-2">
                        <Link
                          href={`/articles/${article.id}`}
                          className="truncate hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {article.name}
                        </Link>
                        {!article.active && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t('status_inactive')}
                          </span>
                        )}
                      </span>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer count (concept pgnote) */}
          <p className="px-1 text-xs text-muted-foreground tabular-nums">
            {t('count_footer', { count: sortedArticles.length })}
          </p>

          <ShowMoreFooter
            shown={visibleCount}
            total={sortedArticles.length}
            onMore={() => setVisibleCount((count) => count + SHOW_MORE_STEP)}
          />
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
