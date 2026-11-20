'use client'

import { useCallback, useEffect, useState } from 'react'
import { readPendingReminderBatch, type PendingReminderBatch } from '@/lib/reminders/pending-batch'
import { createClient } from '@/lib/supabase/client'

/**
 * The company's pending daily reminder batch, for the Att göra row that
 * opens its review dialog in place: its operation id and the items still in
 * it, read the same way the row's count is (lib/reminders/pending-batch).
 * Read only while `enabled` (the worklist counted one); null until read,
 * when there is none, or when it could not be read (the row then links to
 * /pending instead).
 */
export function usePendingReminderBatch(companyId: string | null | undefined, enabled: boolean) {
  const [batch, setBatch] = useState<PendingReminderBatch | null>(null)

  const reload = useCallback(async () => {
    if (!enabled || !companyId) return
    const read = await readPendingReminderBatch(createClient(), companyId)
    setBatch(read.ok ? read.batch : null)
  }, [companyId, enabled])

  useEffect(() => {
    if (!enabled || !companyId) return
    let live = true
    // Read after mount, never during render; a later company or flag change starts again.
    queueMicrotask(() => {
      if (live) void reload()
    })
    return () => {
      live = false
    }
  }, [reload, enabled, companyId])

  return { batch: enabled ? batch : null, reload }
}
