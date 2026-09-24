'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SupportLink } from '@/components/ui/support-link'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('app_error_boundary')
  const tc = useTranslations('common')
  useEffect(() => {
    console.error('[dashboard] Unhandled error:', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-xl">{t('title')}</h2>
      <p className="text-muted-foreground text-sm max-w-md text-center">
        {t.rich('body', {
          link: (chunks) => (
            <SupportLink variant="inline" subject="Oväntat fel">{chunks}</SupportLink>
          ),
        })}
      </p>
      <Button onClick={reset}>{tc('retry')}</Button>
    </div>
  )
}
