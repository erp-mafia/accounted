'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { InkorgItem } from '@/lib/inkorg/items'
import type { MissingPurchase } from '@/lib/inkorg/missing'

export type { MissingPurchase }

const ITEMS_URL = '/api/extensions/ext/invoice-inbox/items'
const PURCHASES_URL = '/api/extensions/ext/invoice-inbox/purchases'

export type LoadState = 'loading' | 'ready' | 'failed'

export interface InkorgData {
  items: InkorgItem[]
  itemsState: LoadState
  purchases: MissingPurchase[]
  purchasesState: LoadState
  /** Read the list (and the purchases) again; resolves when both answered. */
  refresh: () => Promise<void>
}

/**
 * The inbox items and the purchases without underlag, over the extension's
 * HTTP API, the same reads the Underlag workspace makes. The list is read
 * again on every change to the company's invoice_inbox_items rows, so an
 * item booked elsewhere (the assistant, Granskning, another tab) leaves the
 * queue here too.
 */
export function useInkorgData(companyId: string | null): InkorgData {
  const [items, setItems] = useState<InkorgItem[]>([])
  const [itemsState, setItemsState] = useState<LoadState>('loading')
  const [purchases, setPurchases] = useState<MissingPurchase[]>([])
  const [purchasesState, setPurchasesState] = useState<LoadState>('loading')

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch(ITEMS_URL)
      if (!res.ok) throw new Error(`items ${res.status}`)
      const json = (await res.json()) as { data?: { items?: InkorgItem[] } }
      setItems(json.data?.items ?? [])
      setItemsState('ready')
    } catch {
      // Keep what is on screen: a failed refetch is not an empty inbox.
      setItemsState((prev) => (prev === 'ready' ? 'ready' : 'failed'))
    }
  }, [])

  const fetchPurchases = useCallback(async () => {
    try {
      const res = await fetch(PURCHASES_URL)
      if (!res.ok) throw new Error(`purchases ${res.status}`)
      const json = (await res.json()) as { data?: { purchases?: MissingPurchase[] } }
      setPurchases(json.data?.purchases ?? [])
      setPurchasesState('ready')
    } catch {
      setPurchasesState((prev) => (prev === 'ready' ? 'ready' : 'failed'))
    }
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([fetchItems(), fetchPurchases()])
  }, [fetchItems, fetchPurchases])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!companyId) return
    const supabase = createClient()
    // The company filter is required: realtime applies the membership-wide
    // SELECT policy, so without it a user in two companies hears both.
    const channel = supabase
      .channel(`invoice_inbox_items:inkorg:${companyId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'invoice_inbox_items', filter: `company_id=eq.${companyId}` },
        () => {
          void fetchItems()
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [companyId, fetchItems])

  // Underlag reaches a purchase from elsewhere too (the customer's AI fetching it in another tab,
  // an approval in Granskning): the purchases are read again when the page comes back into view.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchPurchases()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchPurchases])

  return { items, itemsState, purchases, purchasesState, refresh }
}
