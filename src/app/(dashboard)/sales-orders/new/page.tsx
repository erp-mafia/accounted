'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import SalesOrderForm from '@/components/sales-orders/SalesOrderForm'
import { useViewerRedirect } from '@/components/ui/viewer-lock'

const FORM_ID = 'sales-order-form'

export default function NewSalesOrderPage() {
  const t = useTranslations('sales_order_form')
  const tList = useTranslations('sales_orders')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  // A read-only member gets the list, never the create form.
  const canWrite = useViewerRedirect('/sales-orders')
  if (!canWrite) return null
  return (
    <div className="space-y-8">
      {/* A record with rows is a full page: Avbryt and the one primary sit in
          the top bar and submit the form below through its id. */}
      <PageHeader
        parent={{ label: tList('title'), href: '/sales-orders' }}
        title={t('title_create')}
        action={
          <div className="flex items-center gap-2">
            <Button size="toolbar" type="button" variant="ghost" onClick={() => router.back()} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button size="toolbar" type="submit" form={FORM_ID} loading={submitting}>
              {t('submit_create')}
            </Button>
          </div>
        }
      />
      <SalesOrderForm mode="create" formId={FORM_ID} onSubmittingChange={setSubmitting} />
    </div>
  )
}
