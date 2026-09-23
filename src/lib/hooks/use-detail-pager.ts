'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  computeNeighbors,
  readListContext,
  type ListContext,
} from '@/lib/navigation/list-context'
import { resolveArrowKeyAction } from '@/lib/hooks/detail-pager-guards'

export interface DetailPager {
  prevId: string | null
  nextId: string | null
  /** 1-based position, null when no list context exists (deep link/new tab). */
  index: number | null
  total: number | null
  goPrev: () => void
  goNext: () => void
}

export interface DetailPagerOptions {
  /**
   * Set false to suspend the ArrowLeft/ArrowRight bindings entirely, e.g.
   * while an inline editor with unsaved state is open (paging unmounts the
   * page and would destroy the draft). Buttons stay active.
   */
  keyboard?: boolean
}

/**
 * Prev/next record navigation for detail pages, backed by the list context
 * the originating list page wrote to sessionStorage (lib/navigation/
 * list-context.ts). Also binds ArrowLeft/ArrowRight while no text field or
 * open overlay (dialog, menu, listbox) owns the keys; see
 * lib/hooks/detail-pager-guards.ts for the exact rules. When no context
 * exists everything is null and the pager UI hides; the detail page degrades
 * gracefully.
 */
export function useDetailPager(
  contextKey: string,
  basePath: string,
  currentId: string,
  options?: DetailPagerOptions,
): DetailPager {
  const keyboard = options?.keyboard ?? true
  const router = useRouter()
  const [context, setContext] = useState<ListContext | null>(null)

  // Read in an effect, not during render: sessionStorage does not exist on
  // the server and reading it pre-hydration would mismatch the SSR HTML.
  useEffect(() => {
    setContext(readListContext(contextKey))
  }, [contextKey])

  const neighbors = useMemo(
    () => (context ? computeNeighbors(context.ids, currentId) : null),
    [context, currentId],
  )
  const prevId = neighbors?.prevId ?? null
  const nextId = neighbors?.nextId ?? null

  // router.replace, deliberately not push: stepping through records is one
  // browsing act, so "tillbaka" returns to the list in a single step instead
  // of walking back through every viewed record.
  const goPrev = useCallback(() => {
    if (prevId) router.replace(`${basePath}/${prevId}`)
  }, [basePath, prevId, router])

  const goNext = useCallback(() => {
    if (nextId) router.replace(`${basePath}/${nextId}`)
  }, [basePath, nextId, router])

  useEffect(() => {
    if (!neighbors || !keyboard) return
    const onKeyDown = (e: KeyboardEvent) => {
      const action = resolveArrowKeyAction(e, document)
      if (action === 'prev') goPrev()
      else if (action === 'next') goNext()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [neighbors, keyboard, goPrev, goNext])

  return {
    prevId,
    nextId,
    index: neighbors?.index ?? null,
    total: neighbors?.total ?? null,
    goPrev,
    goNext,
  }
}
