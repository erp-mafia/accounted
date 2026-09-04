'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'
import SalesOrderForm from '@/components/sales-orders/SalesOrderForm'

export default function NewSalesOrderPage() {
  const t = useTranslations('sales_order_form')
  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/sales-orders"
          className="mb-6 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title_create')}</h1>
      </div>
      <SalesOrderForm mode="create" />
    </div>
  )
}
