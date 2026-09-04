'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'
import SalesOrderForm from '@/components/sales-orders/SalesOrderForm'
import type { SalesOrder } from '@/types'

/**
 * Edit an existing kundorder (draft or confirmed). Loads the order with its
 * lines and hands it to the same form used for creation; line ids ride along
 * so delivered/invoiced history survives the replace.
 */
export default function EditSalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const t = useTranslations('sales_order_form')
  const router = useRouter()
  const { toast } = useToast()
  const [order, setOrder] = useState<SalesOrder | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/sales-orders/${id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('load failed')
        const { data } = await res.json()
        return data as SalesOrder
      })
      .then((data) => {
        if (cancelled) return
        if (data.status !== 'draft' && data.status !== 'confirmed') {
          toast({ title: t('not_editable'), variant: 'destructive' })
          router.replace(`/sales-orders/${id}`)
          return
        }
        setOrder(data)
      })
      .catch(() => {
        if (cancelled) return
        toast({ title: t('load_failed_title'), variant: 'destructive' })
        router.replace('/sales-orders')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  if (isLoading) return <DetailPageSkeleton />
  if (!order) return null

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/sales-orders/${id}`}
          className="mb-6 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back_to_order')}
        </Link>
        <h1 data-ph-mask="" className="font-display text-2xl leading-8 tracking-tight">
          {t('title_edit', { number: order.order_number ?? '' })}
        </h1>
      </div>
      <SalesOrderForm mode="edit" initial={order} />
    </div>
  )
}
