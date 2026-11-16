'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import { PageHeader } from '@/components/ui/page-header'
import { LoadError, NotFoundState } from '@/components/ui/empty-state'
import SalesOrderForm from '@/components/sales-orders/SalesOrderForm'
import type { SalesOrder } from '@/types'
import { useViewerRedirect } from '@/components/ui/viewer-lock'

const FORM_ID = 'sales-order-form'

/**
 * Edit an existing kundorder (draft or confirmed). Loads the order with its
 * lines and hands it to the same form used for creation; line ids ride along
 * so delivered/invoiced history survives the replace.
 */
export default function EditSalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('sales_order_form')
  const tList = useTranslations('sales_orders')
  const tDetail = useTranslations('sales_order_detail')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { toast } = useToast()
  const [order, setOrder] = useState<SalesOrder | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // The read failed: the page says so with "Försök igen" (bumps reloadKey).
  const [loadFailed, setLoadFailed] = useState(false)
  // No order under this id: not a failure to retry.
  const [notFound, setNotFound] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const canWrite = useViewerRedirect(`/sales-orders/${id}`)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/sales-orders/${id}`)
      .then(async (res) => {
        if (res.status === 404) return null
        if (!res.ok) throw new Error('load failed')
        const { data } = await res.json()
        return data as SalesOrder
      })
      .then((data) => {
        if (cancelled) return
        if (!data) {
          setNotFound(true)
          return
        }
        if (data.status !== 'draft' && data.status !== 'confirmed') {
          toast({ title: t('not_editable'), variant: 'destructive' })
          router.replace(`/sales-orders/${id}`)
          return
        }
        setOrder(data)
      })
      .catch(() => {
        if (cancelled) return
        setLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey])

  // A read-only member gets the order, never its edit form.
  if (!canWrite) return null
  if (isLoading) return <DetailPageSkeleton />
  if (!order) {
    if (!loadFailed && !notFound) return null
    return (
      <div className="space-y-8">
        <PageHeader title={tList('title')} />
        {notFound ? (
          <NotFoundState title={tDetail('not_found')} backHref="/sales-orders" backLabel={tCommon('back_to_list')} />
        ) : (
        <LoadError
          title={t('load_failed_title')}
          onRetry={() => {
            setLoadFailed(false)
            setIsLoading(true)
            setReloadKey((key) => key + 1)
          }}
        />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* data-ph-mask: the title carries the order number */}
      <PageHeader
        parent={{ label: tList('title'), href: '/sales-orders' }}
        title={<span data-ph-mask="">{t('title_edit', { number: order.order_number ?? '' })}</span>}
        action={
          <div className="flex items-center gap-2">
            <Button size="toolbar" type="button" variant="ghost" onClick={() => router.back()} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button size="toolbar" type="submit" form={FORM_ID} loading={submitting}>
              {t('submit_edit')}
            </Button>
          </div>
        }
      />
      <SalesOrderForm mode="edit" initial={order} formId={FORM_ID} onSubmittingChange={setSubmitting} />
    </div>
  )
}
