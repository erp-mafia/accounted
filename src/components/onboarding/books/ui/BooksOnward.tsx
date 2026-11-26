'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { BooksCtx } from '../context'

/**
 * The way on from the books (the SIE step and the provider step): the one
 * button, named after the step that follows. With `bringIntoView` it is the
 * button of the done view under the title, and someone who scrolled down to
 * follow the run is brought back to it when it appears.
 */
export function BooksOnward({ ctx, bringIntoView = false }: { ctx: BooksCtx; bringIntoView?: boolean }) {
  const t = useTranslations('books')
  const { dispatch, flags } = ctx
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (bringIntoView) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [bringIntoView])
  return (
    <div className="jny-qactions" ref={ref}>
      <Button size="lg" onClick={() => dispatch({ type: 'AFTER_BOOKS', flags })}>
        {flags.hasBanking ? t('to_bank') : flags.hasSkatteverket ? t('to_skv') : t('to_done')}
      </Button>
    </div>
  )
}
