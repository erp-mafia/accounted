'use client'

import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

export function DialogLoadingSkeleton() {
  const t = useTranslations('common')

  return (
    <Dialog open>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle className="sr-only">{t('loading')}</DialogTitle>
        <div className="space-y-4 py-4" role="status">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
