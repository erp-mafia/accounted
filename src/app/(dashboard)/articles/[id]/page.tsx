'use client'

import { useState, useEffect, useCallback, useRef, use } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { DetailColumns } from '@/components/ui/detail-columns'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { AttnLine } from '@/components/ui/attn-line'
import { LoadError, NotFoundState } from '@/components/ui/empty-state'
import { PageHeader, PageHeaderParent, PageHeaderBelow } from '@/components/ui/page-header'
import { PageHeaderActions } from '@/components/ui/page-header-actions'
import { RecordAction } from '@/components/ui/record-header'
import ArticleForm from '@/components/articles/ArticleForm'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { TrashIcon } from '@/components/icons'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import { DEDUCTION_TYPE_LABEL_KEYS, articleDeductionPrefill, workTypeLabel } from '@/lib/bookkeeping/rot-rut-rules'
import type { Article, ArticleType, CreateArticleInput } from '@/types'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'

const ARTICLE_TYPE_KEY: Record<ArticleType, string> = {
  vara: 'type_vara',
  tjanst: 'type_tjanst',
}

export default function ArticleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('article_detail')
  const tArticles = useTranslations('articles')
  const tCommon = useTranslations('common')
  const tInvoices = useTranslations('invoices')
  const errorLocale = useLocale() as ErrorLocale
  const [article, setArticle] = useState<Article | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // The last read failed. With no article on screen the page says so in
  // place of it; an article already on screen stays, with one line above.
  const [loadFailed, setLoadFailed] = useState(false)
  // An article that does not exist (404) is not a failure to retry.
  const [notFound, setNotFound] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isTogglingActive, setIsTogglingActive] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  useEffect(() => {
    fetchArticle()
  }, [id])

  async function fetchArticle() {
    setIsLoading(true)
    try {
      const response = await fetch(`/api/articles/${id}`)
      if (response.status === 404) {
        setNotFound(true)
        return
      }
      if (!response.ok) {
        throw new Error('Load failed')
      }
      const { data } = await response.json()
      setArticle(data)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }

  // Update runs through useSubmitWithAccountActivation so an
  // ACCOUNTS_NOT_IN_CHART response (revenue account not yet activated) opens
  // the standard activate-and-retry dialog: same UX as the journal entry form.
  const pendingUpdateRef = useRef<CreateArticleInput | null>(null)
  const submitUpdate = useCallback(async () => {
    const response = await fetch(`/api/articles/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingUpdateRef.current),
    })
    return throwOnStructuredError(response)
  }, [id])
  const {
    runSubmit: runUpdate,
    dialog: activationDialog,
    confirm: confirmActivation,
    cancel: cancelActivation,
  } = useSubmitWithAccountActivation(submitUpdate)

  async function handleUpdate(data: CreateArticleInput) {
    setIsUpdating(true)
    pendingUpdateRef.current = data
    try {
      await runUpdate()
      toast({
        title: t('updated_title'),
        description: data.name,
      })
      setIsEditOpen(false)
      // Every article picker reads the cached register: refresh it now.
      void invalidateReferenceData('ref:articles')
      fetchArticle()
    } catch (err) {
      // The user closing the activation dialog is not an error worth toasting.
      if (!(err instanceof Error && err.message === 'cancelled')) {
        const body = (err as { body?: unknown }).body
        toast({
          title: t('update_failed_title'),
          description: getErrorMessage(body ?? err, { context: 'article', locale: errorLocale }),
          variant: 'destructive',
        })
      }
    } finally {
      setIsUpdating(false)
    }
  }

  // Soft deactivation is the answer for an article that has already been used
  // on an invoice: the delete path refuses those (ARTICLE_IN_USE), while
  // active=false hides it from the invoice picker, the export and the MCP
  // listing without touching invoice history. Reactivation is not destructive,
  // so only the deactivate direction confirms.
  async function handleToggleActive() {
    if (!article) return
    const nextActive = !article.active

    if (!nextActive) {
      const ok = await confirmAction({
        title: t('deactivate_confirm_title', { name: article.name }),
        description: t('deactivate_confirm_description'),
        confirmLabel: t('deactivate_confirm_label'),
        variant: 'warning',
      })
      if (!ok) return
    }

    setIsTogglingActive(true)
    try {
      const response = await fetch(`/api/articles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: nextActive }),
      })
      const { data } = (await throwOnStructuredError(response)) as { data: Article }

      setArticle(data)
      void invalidateReferenceData('ref:articles')
      toast({
        title: nextActive ? t('activated_title') : t('deactivated_title'),
        description: article.name,
      })
    } catch (err) {
      const body = (err as { body?: unknown }).body
      toast({
        title: nextActive ? t('activate_failed_title') : t('deactivate_failed_title'),
        description: getErrorMessage(body ?? err, { context: 'article', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsTogglingActive(false)
    }
  }

  async function handleDelete() {
    if (!article) return
    const ok = await confirmAction({
      title: t('delete_confirm_title', { name: article.name }),
      description: t('delete_confirm_description'),
      confirmLabel: t('delete_confirm_label'),
      variant: 'destructive',
    })
    if (!ok) return

    setIsDeleting(true)
    try {
      const response = await fetch(`/api/articles/${id}`, {
        method: 'DELETE',
      })

      await throwOnStructuredError(response)

      toast({
        title: t('deleted_title'),
        description: article.name,
      })
      void invalidateReferenceData('ref:articles')
      router.push('/articles')
    } catch (err) {
      const body = (err as { body?: unknown }).body
      toast({
        title: t('delete_failed_title'),
        description: getErrorMessage(body ?? err, { context: 'article', locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }

  if (isLoading) {
    return <DetailPageSkeleton />
  }

  if (!article) {
    if (!loadFailed && !notFound) return null
    return (
      <div className="space-y-8">
        <PageHeader title={tArticles('title')} />
        {notFound ? (
          <NotFoundState title={t('not_found')} backHref="/articles" backLabel={tCommon('back_to_list')} />
        ) : (
          <LoadError title={t('load_failed_title')} onRetry={() => void fetchArticle()} />
        )}
      </div>
    )
  }

  // "RUT · Städning" for a work-type code, "RUT" for a legacy kind-only row,
  // "Grön teknik · Installation av solceller" for an installation type,
  // nothing for values that are not a housework flag (mis-mapped imports) or
  // that the article's type cannot carry (ROT/RUT on goods): the same rule as
  // the invoice pre-fill.
  const houseworkDisplay = (() => {
    const { deductionType, workType } = articleDeductionPrefill(article)
    if (!deductionType) return null
    const kind = tInvoices(DEDUCTION_TYPE_LABEL_KEYS[deductionType])
    const label = workTypeLabel(workType)
    return label ? `${kind} · ${label}` : kind
  })()

  const articleFacts = (
    <>
      <span className="tabular-nums">
        {t(ARTICLE_TYPE_KEY[article.type])}
        {article.article_number ? ` · #${article.article_number}` : ''}
      </span>
      {!article.active && (
        <Badge variant="outline" className="font-normal">
          {t('status_inactive')}
        </Badge>
      )}
    </>
  )

  return (
    <div className="space-y-8 stagger-enter">
      {/* Header: the page-header hooks make it the panel's top bar
          (convention 2), like the customer and supplier detail pages: name,
          a quiet type/status kicker, quiet actions right. The sidebar says
          where we are, so there is no back link. */}
      <div className="page-header page-header-wrap flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="page-header-lead min-w-0">
          <PageHeaderParent label={tArticles('title')} href="/articles" />
          <h1 className="page-header-title">{article.name}</h1>
          {/* On a phone the bar has no room for this: it is the first line under the bar (PageHeaderBelow). */}
          <p data-below="" className="page-header-meta mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {articleFacts}
          </p>
        </div>

        <PageHeaderActions className="page-header-action flex shrink-0 flex-wrap items-center justify-end gap-1">
          <RecordAction canWrite={canWrite} lockedTitle={t('viewer_disabled_tooltip')} onClick={() => setIsEditOpen(true)}>{t('edit')}</RecordAction>
          <RecordAction canWrite={canWrite} lockedTitle={t('viewer_disabled_tooltip')} onClick={handleToggleActive} loading={isTogglingActive}>{article.active ? t('deactivate') : t('activate')}</RecordAction>
          <RecordAction canWrite={canWrite} lockedTitle={t('viewer_disabled_tooltip')} onClick={handleDelete} destructive loading={isDeleting} icon={<TrashIcon className="h-4 w-4" />}>{t('delete')}</RecordAction>
        </PageHeaderActions>
      </div>
      <PageHeaderBelow>{articleFacts}</PageHeaderBelow>

      {loadFailed && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void fetchArticle() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}

      <DetailColumns>
        <DetailSection kicker={t('section_pricing')}>
          <DefRow label={t('label_price')}>
            <span className="tabular-nums">
              {formatCurrency(article.price_excl_vat, article.currency)}
            </span>
          </DefRow>
          <DefRow label={t('label_vat')}>
            <span className="tabular-nums">{article.vat_rate} %</span>
          </DefRow>
          <DefRow label={t('label_unit')}>{article.unit}</DefRow>
          {article.cost_price != null && (
            <DefRow label={t('label_cost_price')}>
              <span className="tabular-nums">
                {formatCurrency(article.cost_price, article.currency)}
              </span>
            </DefRow>
          )}
        </DetailSection>

        <DetailSection kicker={t('section_accounting')}>
          <DefRow label={t('label_revenue_account')}>
            {article.revenue_account ? (
              <span className="tabular-nums">{article.revenue_account}</span>
            ) : (
              <span className="text-muted-foreground">{t('revenue_account_auto')}</span>
            )}
          </DefRow>
          {houseworkDisplay && (
            <DefRow label={t('label_housework')}>{houseworkDisplay}</DefRow>
          )}
        </DetailSection>

        {/* Optional facts (English name, EAN) are omitted row-wise; when none
            exist the whole section goes, so the document never pads itself
            with placeholders for facts nobody entered. */}
        {(article.name_en || article.ean) && (
          <DetailSection kicker={t('section_details')}>
            {article.name_en && <DefRow label={t('label_name_en')}>{article.name_en}</DefRow>}
            {article.ean && (
              <DefRow label={t('label_ean')}>
                <span className="tabular-nums">{article.ean}</span>
              </DefRow>
            )}
          </DetailSection>
        )}

        {article.notes && (
          <DetailSection kicker={t('section_notes')}>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{article.notes}</p>
          </DetailSection>
        )}
      </DetailColumns>

      <DestructiveConfirmDialog {...confirmDialogProps} />

      <ActivateAccountsDialog
        open={activationDialog.open}
        accountNumbers={activationDialog.accountNumbers}
        onConfirm={confirmActivation}
        onCancel={cancelActivation}
        confirmLabel={t('activate_and_save')}
      />

      {/* Edit dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{t('edit_dialog_title')}</DialogTitle>
          </DialogHeader>
          <ArticleForm
            onSubmit={handleUpdate}
            isLoading={isUpdating}
            onCancel={() => setIsEditOpen(false)}
            initialData={{
              article_number: article.article_number || undefined,
              name: article.name,
              name_en: article.name_en || undefined,
              type: article.type,
              unit: article.unit,
              price_excl_vat: article.price_excl_vat,
              vat_rate: article.vat_rate,
              currency: article.currency,
              revenue_account: article.revenue_account || undefined,
              cost_price: article.cost_price ?? undefined,
              ean: article.ean || undefined,
              housework_type: article.housework_type || undefined,
              notes: article.notes || undefined,
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
