'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import SalesOrderForm from '@/components/sales-orders/SalesOrderForm'

export default function NewSalesOrderPage() {
  const t = useTranslations('sales_order_form')
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title_create')}
        action={
          <Link
            href="/sales-orders"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('back')}
          </Link>
        }
      />
      <SalesOrderForm mode="create" />
    </div>
  )
}
