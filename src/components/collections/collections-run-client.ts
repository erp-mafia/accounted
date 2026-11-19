'use client'

import { useCallback, useEffect, useState } from 'react'
import { COLLECTIONS_BATCH_TYPE, type BatchItem } from '@/lib/collections/batch'
import { runItems } from '@/lib/collections/batch-dialog'
import { createClient } from '@/lib/supabase/client'

/**
 * The company's pending daily collections run (at most one), for the Att
 * göra row that opens its review dialog in place: its operation id and the
 * items still in it. Read only while `enabled` (the worklist counted one);
 * null until read, or when there is none. RLS scopes both tables; the
 * company filter is defense in depth.
 */
export function usePendingCollectionsRun(companyId: string | null | undefined, enabled: boolean) {
  const [run, setRun] = useState<{ id: string; items: BatchItem[] } | null>(null)

  const reload = useCallback(async () => {
    if (!enabled || !companyId) return
    const supabase = createClient()
    const { data, error } = await supabase
      .from('pending_operations')
      .select('id, params')
      .eq('company_id', companyId)
      .eq('operation_type', COLLECTIONS_BATCH_TYPE)
      .eq('status', 'pending')
      .limit(1)
    const op = !error ? ((data ?? [])[0] as { id: string; params: unknown } | undefined) : undefined
    if (!op) {
      setRun(null)
      return
    }
    const removals = await supabase
      .from('collection_batch_removals')
      .select('invoice_id')
      .eq('company_id', companyId)
      .eq('pending_operation_id', op.id)
    const removed = removals.error ? [] : ((removals.data ?? []) as Array<{ invoice_id: string }>).map((r) => r.invoice_id)
    setRun({ id: op.id, items: runItems(op.params, removed) })
  }, [companyId, enabled])

  useEffect(() => {
    if (!enabled || !companyId) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) void reload()
    })
    return () => {
      cancelled = true
    }
  }, [reload, enabled, companyId])

  return { run: enabled ? run : null, reload }
}
