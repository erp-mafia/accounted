'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export type SortDirection = 'asc' | 'desc'

/** The list's sort from `?sort=&dir=`: an unknown column falls back to the default, ascending unless dir=desc. */
export function readUrlSort<C extends string>(
  params: URLSearchParams,
  columns: readonly C[],
  defaultColumn: C,
): { column: C; direction: SortDirection } {
  const sort = params.get('sort') ?? ''
  const column = (columns as readonly string[]).includes(sort) ? (sort as C) : defaultColumn
  return { column, direction: params.get('dir') === 'desc' ? 'desc' : 'asc' }
}

/** The query after clicking `column`: the same column flips direction, another starts ascending. Other params stay. */
export function toggledUrlSort<C extends string>(
  params: URLSearchParams,
  columns: readonly C[],
  defaultColumn: C,
  column: C,
): URLSearchParams {
  const current = readUrlSort(params, columns, defaultColumn)
  const next = new URLSearchParams(params.toString())
  next.set('sort', column)
  next.set('dir', column === current.column && current.direction === 'asc' ? 'desc' : 'asc')
  return next
}

/**
 * A client-side list's sort kept in the URL (?sort=&dir=), so a reload, a
 * shared link and the back button keep it. `onChange` runs before the URL
 * moves, e.g. to reset a "Ladda fler" cut. The customer and article lists
 * each wrote this by hand.
 */
export function useUrlSort<C extends string>(
  columns: readonly C[],
  defaultColumn: C,
  onChange?: () => void,
): { column: C; direction: SortDirection; toggle: (column: C) => void } {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { column, direction } = readUrlSort(new URLSearchParams(searchParams.toString()), columns, defaultColumn)

  const toggle = useCallback(
    (next: C) => {
      onChange?.()
      const params = toggledUrlSort(new URLSearchParams(searchParams.toString()), columns, defaultColumn, next)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [onChange, searchParams, columns, defaultColumn, router, pathname],
  )

  return { column, direction, toggle }
}
