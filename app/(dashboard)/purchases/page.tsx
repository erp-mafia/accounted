'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { useShell } from '@/components/dashboard/ShellProvider'
import { PurchasesFlow } from '@/components/purchases/PurchasesFlow'

/**
 * /purchases: the Inköp landing in shell v2, the flow across both kinds of
 * document. Shell v1 has no such page and keeps landing on the invoice
 * list, so it is sent there.
 */
export default function PurchasesPage() {
  const t = useTranslations('purchases_flow')
  const shell = useShell()
  const router = useRouter()

  useEffect(() => {
    if (shell !== 'v2') router.replace('/supplier-invoices')
  }, [shell, router])

  if (shell !== 'v2') return null

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        action={
          <Button size="sm" asChild>
            <Link href="/e/general/invoice-inbox">{t('upload')}</Link>
          </Button>
        }
      />
      <PurchasesFlow />
    </div>
  )
}
