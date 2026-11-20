'use client'

import { useCallback, useState, type ReactNode } from 'react'
import VoucherWarningsDialog from '@/components/bookkeeping/VoucherWarningsDialog'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'

interface CommitDraftCallbacks<T> {
  /** The draft is posted: `posted` is the route's `data`. */
  onPosted: (posted: T) => Promise<void> | void
  /** Any other refusal, as the route answered it. */
  onFailed: (result: unknown) => void
}

/**
 * POST /api/bookkeeping/journal-entries/:id/commit with the booking-time
 * voucher warnings handled: a VOUCHER_NEEDS_CONFIRMATION answer opens the
 * warnings dialog, and "Bokför ändå" posts again with the codes it showed
 * (lib/bookkeeping/voucher-warnings-guard.ts). Render `dialog` once.
 */
export function useCommitDraft<T = unknown>({ onPosted, onFailed }: CommitDraftCallbacks<T>): {
  commit: (entryId: string) => Promise<void>
  dialog: ReactNode
} {
  const [warnings, setWarnings] = useState<VoucherWarning[] | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

  const send = useCallback(
    async (entryId: string, acknowledged?: string[]) => {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entryId}/commit`, {
        method: 'POST',
        ...(acknowledged
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledged_warnings: acknowledged }) }
          : {}),
      })
      const result = await res.json()
      if (res.ok) {
        setPendingId(null)
        await onPosted(result.data as T)
        return
      }
      const details = result?.error?.details
      if (result?.error?.code === 'VOUCHER_NEEDS_CONFIRMATION' && Array.isArray(details?.warnings)) {
        // A resend that meets a new warning shows the dialog again.
        setPendingId(entryId)
        setWarnings(details.warnings as VoucherWarning[])
        return
      }
      setPendingId(null)
      onFailed(result)
    },
    [onPosted, onFailed],
  )

  const commit = useCallback((entryId: string) => send(entryId), [send])

  const confirm = async () => {
    const entryId = pendingId
    const codes = warnings?.map((w) => w.code)
    setWarnings(null)
    if (!entryId || !codes) return
    setResending(true)
    try {
      await send(entryId, codes)
    } finally {
      setResending(false)
    }
  }

  const dialog = (
    <VoucherWarningsDialog
      warnings={warnings}
      processing={resending}
      onCancel={() => {
        setWarnings(null)
        setPendingId(null)
      }}
      onConfirm={confirm}
    />
  )

  return { commit, dialog }
}
