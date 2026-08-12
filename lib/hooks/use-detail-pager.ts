'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  computeNeighbors,
  readListContext,
  type ListContext,
} from '@/lib/navigation/list-context'

export interface DetailPager {
  prevId: string | null
  nextId: string | null
  /** 1-based position, null when no list context exists (deep link/new tab). */
  index: number | null
  total: number | null
  goPrev: () => void
  goNext: () => void
}

/** True for targets that own arrow keys: text fields, selects, contentEditable. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/**
 * Prev/next record navigation for detail pages, backed by the list context
 * the originating list page wrote to sessionStorage (lib/navigation/
 * list-context.ts). Also binds ArrowLeft/ArrowRight while no text field or
 * dialog is active. When no context exists everything is null and the pager
 * UI hides; the detail page degrades gracefully.
 */
export function useDetailPager(
  contextKey: string,
  basePath: string,
  currentId: string,
): DetailPager {
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
    if (!neighbors) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.defaultPrevented || e.isComposing) return
      // Plain arrows only: modified arrows are browser/OS shortcuts
      // (cmd+arrow is history navigation on macOS).
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      // Never steal arrows from text editing (e.g. the notes textarea on the
      // verifikat page) or from an open dialog's focus handling.
      if (isEditableTarget(e.target)) return
      if (document.querySelector('[role="dialog"]')) return
      if (e.key === 'ArrowLeft') goPrev()
      else goNext()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [neighbors, goPrev, goNext])

  return {
    prevId,
    nextId,
    index: neighbors?.index ?? null,
    total: neighbors?.total ?? null,
    goPrev,
    goNext,
  }
}
