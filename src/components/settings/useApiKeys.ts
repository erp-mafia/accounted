'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'

/** One row of GET /api/settings/api-keys (the key value is never returned). */
export interface ApiKeyRow {
  id: string
  key_prefix: string
  name: string
  scopes: string[] | null
  rate_limit_rpm: number
  mode?: 'live' | 'test'
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
  client?: string | null
  source?: 'signin' | 'manual'
}

/**
 * The active company's live API keys, shared by the connections list and the
 * developer section so a key created or revoked in one shows in the other.
 */
export function useApiKeys() {
  const t = useTranslations('settings_api_keys')
  const { toast } = useToast()
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/api-keys')
      const json = await res.json()
      if (json.data) {
        setKeys(json.data.filter((k: ApiKeyRow) => !k.revoked_at))
      }
    } catch {
      toast({ title: t('toast_fetch_failed'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    refetch()
    // Connecting happens in another tab (claude.ai, ChatGPT, a terminal
    // sign-in), so re-read when the user comes back to show the new row.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refetch()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refetch])

  /** Revoke without asking: the caller owns the confirm dialog and its copy. */
  const revoke = useCallback(
    async (id: string, toastTitle: string) => {
      try {
        const res = await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(String(res.status))
        setKeys((prev) => prev.filter((k) => k.id !== id))
        toast({ title: toastTitle })
      } catch {
        toast({ title: t('toast_revoke_failed'), variant: 'destructive' })
      }
    },
    [toast, t],
  )

  return { keys, isLoading, refetch, revoke }
}
