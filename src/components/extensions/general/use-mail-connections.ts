'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchMailConnections, type MailConnectionsView } from './mail-connections'

export interface MailConnections {
  /** Null until the first read succeeds. */
  view: MailConnectionsView | null
  loading: boolean
  /** The last read failed: nothing is known about the mailboxes. */
  loadFailed: boolean
  reload: () => Promise<void>
}

/**
 * The company's mailboxes, read once on mount and again on request (after a
 * connect, a disconnect or a hunt pass moved `lastSearchedAt`).
 *
 * `enabled: false` reads nothing: a build without the mail extension has no
 * route to ask, and a 404 there is not a failure worth showing.
 */
export function useMailConnections(enabled = true): MailConnections {
  const [view, setView] = useState<MailConnectionsView | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [loadFailed, setLoadFailed] = useState(false)

  const reload = useCallback(async () => {
    if (!enabled) return
    try {
      const next = await fetchMailConnections()
      setView(next)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  return { view, loading, loadFailed, reload }
}
