'use client'

import { useState, useEffect, useCallback, useRef, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Package,
  Wrench,
  Edit2,
  Trash2,
  Loader2,
  Lock,
} from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency } from '@/lib/utils'
import type { Article, ArticleType, CreateArticleInput } from '@/types'

const ARTICLE_TYPE_KEY: Record<ArticleType, string> = {
  vara: 'type_vara',
  tjanst: 'type_tjanst',
}

const articleTypeIcons: Record<ArticleType, React.ElementType> = {
  vara: Package,
  tjanst: Wrench,
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

  const Icon = articleTypeIcons[article.type]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div>
          <Link
            href="/articles"
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('back')}
          </Link>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-2xl leading-8 tracking-tight">{article.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                {article.active ? (
                  <span className="text-sm text-muted-foreground">{t('status_active')}</span>
                ) : (
                  <Badge variant="outline" className="font-normal">
                    {t('status_inactive')}
                  </Badge>
                )}
                <span className="text-sm text-muted-foreground tabular-nums">
                  {t(ARTICLE_TYPE_KEY[article.type])}
                  {article.article_number ? ` · #${article.article_number}` : ''}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsEditOpen(true)}
            disabled={!canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {canWrite ? <Edit2 className="h-4 w-4 mr-1" /> : <Lock className="h-4 w-4 mr-1" />}
            {t('edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleActive}
            className="min-h-10"
            disabled={isTogglingActive || !canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {isTogglingActive ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : !canWrite ? (
              <Lock className="h-4 w-4 mr-1" />
            ) : article.active ? (
              <Archive className="h-4 w-4 mr-1" />
            ) : (
              <ArchiveRestore className="h-4 w-4 mr-1" />
            )}
            {article.active ? t('deactivate') : t('activate')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDelete}
            className="min-h-10 text-destructive hover:text-destructive"
            disabled={isDeleting || !canWrite}
            title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
          >
            {isDeleting ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : canWrite ? (
              <Trash2 className="h-4 w-4 mr-1" />
            ) : (
              <Lock className="h-4 w-4 mr-1" />
            )}
            {t('delete')}
          </Button>
        </div>
      </div>

      {/* Info cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* Pricing */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_pricing')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm flex items-center justify-between">
              <span className="text-muted-foreground">{t('label_price')}</span>
              <span className="tabular-nums">{formatCurrency(article.price_excl_vat, article.currency)}</span>
            </div>
            <div className="text-sm flex items-center justify-between">
              <span className="text-muted-foreground">{t('label_vat')}</span>
              <span className="tabular-nums">{article.vat_rate} %</span>
            </div>
            <div className="text-sm flex items-center justify-between">
              <span className="text-muted-foreground">{t('label_unit')}</span>
              <span>{article.unit}</span>
            </div>
            {article.cost_price != null && (
              <div className="text-sm flex items-center justify-between">
                <span className="text-muted-foreground">{t('label_cost_price')}</span>
                <span className="tabular-nums">{formatCurrency(article.cost_price, article.currency)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Accounting */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_accounting')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm flex items-center justify-between">
              <span className="text-muted-foreground">{t('label_revenue_account')}</span>
              <span className="tabular-nums">
                {article.revenue_account || t('revenue_account_auto')}
              </span>
            </div>
            {article.type === 'tjanst' && article.housework_type && (
              <div className="text-sm flex items-center justify-between">
                <span className="text-muted-foreground">{t('label_housework')}</span>
                <span>{article.housework_type}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_details')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {article.name_en && (
              <div className="text-sm flex items-center justify-between">
                <span className="text-muted-foreground">{t('label_name_en')}</span>
                <span className="truncate ml-2">{article.name_en}</span>
              </div>
            )}
            {article.ean && (
              <div className="text-sm flex items-center justify-between">
                <span className="text-muted-foreground">{t('label_ean')}</span>
                <span className="tabular-nums">{article.ean}</span>
              </div>
            )}
            {!article.name_en && !article.ean && (
              <p className="text-sm text-muted-foreground">{t('no_details')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Notes */}
      {article.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('section_notes')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{article.notes}</p>
          </CardContent>
        </Card>
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
