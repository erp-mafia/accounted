'use client'

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { Plus, Search, Package, Lock, ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import ArticleForm from '@/components/articles/ArticleForm'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { ReportExportMenu } from '@/components/reports/ReportExportMenu'
import { formatCurrency } from '@/lib/utils'
import Link from 'next/link'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Article, ArticleType, CreateArticleInput } from '@/types'

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

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'sv', { sensitivity: 'base' })
}

function ArticlesPageInner() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const [articles, setArticles] = useState<Article[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('articles')
  const errorLocale = useLocale() as ErrorLocale

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const sortParam = searchParams.get('sort')
  const dirParam = searchParams.get('dir')
  const sortColumn: SortColumn = (SORTABLE_COLUMNS as ReadonlyArray<string>).includes(sortParam ?? '')
    ? (sortParam as SortColumn)
    : 'name'
  const sortDir: SortDir = dirParam === 'desc' ? 'desc' : 'asc'

  const updateSort = useCallback(
    (column: SortColumn) => {
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
      .eq('active', true)
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

  const filteredArticles = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return articles
    return articles.filter((a) => {
      return (
        a.name.toLowerCase().includes(term) ||
        a.name_en?.toLowerCase().includes(term) ||
        a.article_number?.toLowerCase().includes(term)
      )
    })
  }, [articles, searchTerm])

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
          cmp = compareStrings(a.article_number || '', b.article_number || '')
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

  function SortableHeader({
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
      <TableHead className={className}>
        <button
          type="button"
          onClick={() => updateSort(column)}
          className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {label}
          <Icon className="h-3 w-3 opacity-70" aria-hidden="true" />
        </button>
      </TableHead>
    )
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        action={
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
                />
              </DialogContent>
            </Dialog>
          </div>
        }
      />

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Article list */}
      {isLoading ? (
        <>
          {/* Desktop skeleton */}
          <Card className="hidden md:block">
            <CardContent className="p-6 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
          {/* Mobile skeleton */}
          <div className="grid gap-4 md:hidden">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-1/3 mt-2" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-4 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      ) : sortedArticles.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            {searchTerm ? (
              <EmptyState
                icon={Package}
                title={t('no_search_results_title')}
                description={t('no_search_results_description', { term: searchTerm })}
              />
            ) : (
              <EmptyState
                icon={Package}
                title={t('empty_title')}
                description={t('empty_description')}
                actionLabel={canWrite ? t('empty_action') : undefined}
                onAction={canWrite ? () => setIsDialogOpen(true) : undefined}
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader column="article_number" label={t('col_number')} />
                    <SortableHeader column="name" label={t('col_name')} />
                    <SortableHeader column="type" label={t('col_type')} />
                    <SortableHeader column="unit" label={t('col_unit')} />
                    <SortableHeader
                      column="price_excl_vat"
                      label={t('col_price')}
                      className="text-right"
                    />
                    <SortableHeader
                      column="vat_rate"
                      label={t('col_vat')}
                      className="text-right"
                    />
                    <TableHead className="text-right">{t('col_status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedArticles.map((article) => (
                    <TableRow
                      key={article.id}
                      className="cursor-pointer"
                      onClick={() => router.push(`/articles/${article.id}`)}
                    >
                      <TableCell className="tabular-nums text-muted-foreground">
                        {article.article_number || '-'}
                      </TableCell>
                      <TableCell className="font-medium">
                        <Link
                          href={`/articles/${article.id}`}
                          className="hover:text-primary transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {article.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t(ARTICLE_TYPE_LABEL_KEYS[article.type])}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{article.unit}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(article.price_excl_vat)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {article.vat_rate} %
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={article.active ? 'success' : 'secondary'}>
                          {article.active ? t('status_active') : t('status_inactive')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Mobile card list */}
          <div className="grid gap-4 md:hidden">
            {sortedArticles.map((article) => (
              <Link key={article.id} href={`/articles/${article.id}`}>
                <Card className="cursor-pointer transition-colors duration-150 hover:bg-secondary/60 h-full group">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="text-base truncate group-hover:text-primary transition-colors">
                          {article.name}
                        </CardTitle>
                        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                          {t(ARTICLE_TYPE_LABEL_KEYS[article.type])}
                          {article.article_number ? ` · #${article.article_number}` : ''}
                        </div>
                      </div>
                      <span className="font-display text-lg tabular-nums shrink-0">
                        {formatCurrency(article.price_excl_vat)}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                      <span>{t('per_unit', { unit: article.unit })}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t('vat_label_value', { rate: article.vat_rate })}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
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
