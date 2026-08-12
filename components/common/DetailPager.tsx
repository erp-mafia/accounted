'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useDetailPager } from '@/lib/hooks/use-detail-pager'

interface DetailPagerProps {
  /** Storage key from listContextKey(), matching what the list page wrote. */
  contextKey: string
  /** Detail route prefix without trailing slash, e.g. '/invoices'. */
  basePath: string
  currentId: string
  /**
   * Set false to suspend arrow-key paging, e.g. while an inline editor with
   * unsaved state is open. The chevron buttons stay active.
   */
  keyboard?: boolean
  className?: string
}

/**
 * Compact prev/next control for detail pages: two chevrons around an
 * "n av m" position. Renders nothing when no list context exists (deep
 * link or new tab), so pages degrade gracefully.
 */
export function DetailPager({
  contextKey,
  basePath,
  currentId,
  keyboard = true,
  className,
}: DetailPagerProps) {
  const t = useTranslations('common')
  const pager = useDetailPager(contextKey, basePath, currentId, { keyboard })
  if (pager.index === null || pager.total === null) return null
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        variant="ghost"
        size="icon"
        onClick={pager.goPrev}
        disabled={!pager.prevId}
        aria-label={t('pager_previous')}
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>
      <span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        {t('pager_position', { index: pager.index, total: pager.total })}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={pager.goNext}
        disabled={!pager.nextId}
        aria-label={t('pager_next')}
      >
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  )
}
