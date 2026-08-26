'use client'

import { useState, useEffect, useCallback, useRef, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import ArticleForm from '@/components/articles/ArticleForm'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { ArrowLeft, Loader2, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import { parseArticleHouseworkType, workTypeLabel } from '@/lib/invoices/rot-rut-rules'
import type { Article, ArticleType, CreateArticleInput } from '@/types'

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
  const errorLocale = useLocale() as ErrorLocale
  const [article, setArticle] = useState<Article | null>(null)
  const [isLoading, setIsLoading] = useState(true)
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
      if (!response.ok) {
        throw new Error('Not found')
      }
      const { data } = await response.json()
      setArticle(data)
    } catch {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
      router.push('/articles')
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
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!article) return null

  // "RUT · Städning" for a work-type code, "RUT" for a legacy kind-only row,
  // nothing for values that are not a housework flag (mis-mapped imports).
  const houseworkDisplay = (() => {
    const { deductionType, workType } = parseArticleHouseworkType(article.housework_type)
    if (!deductionType) return null
    const label = workTypeLabel(workType)
    return label ? `${deductionType.toUpperCase()} · ${label}` : deductionType.toUpperCase()
  })()

  return (
    <div className="max-w-2xl space-y-8 stagger-enter">
      {/* Header: serif name over a quiet type/status kicker, quiet actions right */}
      <div>
        <Link
          href="/articles"
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-8 tracking-tight">{article.name}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="tabular-nums">
                {t(ARTICLE_TYPE_KEY[article.type])}
                {article.article_number ? ` · #${article.article_number}` : ''}
                {article.active ? ` · ${t('status_active')}` : ''}
              </span>
              {!article.active && (
                <Badge variant="outline" className="font-normal">
                  {t('status_inactive')}
                </Badge>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditOpen(true)}
              className="min-h-10 text-muted-foreground hover:text-foreground"
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {!canWrite && <Lock className="h-4 w-4 mr-1" />}
              {t('edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleToggleActive}
              className="min-h-10 text-muted-foreground hover:text-foreground"
              disabled={isTogglingActive || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {isTogglingActive ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : !canWrite ? (
                <Lock className="h-4 w-4 mr-1" />
              ) : null}
              {article.active ? t('deactivate') : t('activate')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              className="min-h-10 text-muted-foreground hover:text-destructive"
              disabled={isDeleting || !canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : !canWrite ? (
                <Lock className="h-4 w-4 mr-1" />
              ) : null}
              {t('delete')}
            </Button>
          </div>
        </div>
      </div>

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
        {article.type === 'tjanst' && houseworkDisplay && (
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
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
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
