'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'

// What the bank file, register and SIE import histories share: one copy, so
// a fix to how a history loads or shows its status reaches all three.

/**
 * A history's rows from `url` (a `{ data: T[] }` list route). `rows` is null
 * until the first read lands; a failed read sets `loadFailed` and keeps the
 * rows already on screen, so the caller can say so in place of or above them.
 */
export function useImportHistoryRows<T>(url: string) {
  const [rows, setRows] = useState<T[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const reload = useCallback(async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      const data = await res.json()
      setRows(Array.isArray(data.data) ? data.data : [])
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    }
  }, [url])

  useEffect(() => {
    void reload()
  }, [reload])

  return { rows, loadFailed, reload }
}

/** Three 44px rows shaped like a history row while the first read runs. */
export function ImportHistorySkeleton() {
  return (
    <LateReveal role="status">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="ml-auto h-3.5 w-20" />
        </div>
      ))}
    </LateReveal>
  )
}

/** An import's status: a tag when it needs attention, else quiet text. */
export function ImportStatus({ label, variant }: { label: string; variant?: 'secondary' | 'warning' | 'destructive' }) {
  if (!variant) return <span className="text-xs text-muted-foreground">{label}</span>
  return (
    <Badge variant={variant} className="font-normal">
      {label}
    </Badge>
  )
}
