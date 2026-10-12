'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { settingsSaveErrorMessage } from '@/lib/settings/save-error'
import type { CompanySettings } from '@/types'

export interface SaveSettingsOptions {
  /** The toast title when the save fails. */
  failedTitle: string
  /**
   * The setting gates a nav row (Körjournal, Kundorder, Dimensioner,
   * Offerter): the nav is rendered by the server layout, so the page is
   * refreshed after the save or the row stays as it was until a reload.
   */
  refreshNav?: boolean
}

/**
 * The one PUT /api/settings for a settings control: sends the patch, and on a
 * refusal or a dropped connection shows the server's own sentence
 * (settingsSaveErrorMessage: the field rules for a validation refusal, the
 * envelope's message otherwise) under `failedTitle`. Resolves to the response
 * body on success and null on failure; the caller patches its settings state
 * with what it sent. Eighteen controls used to write this themselves, and
 * the copies had drifted: some showed no reason at all, one rendered the
 * error envelope as "[object Object]".
 */
export function useSaveSettings(): (
  updates: Partial<CompanySettings>,
  options: SaveSettingsOptions,
) => Promise<Record<string, unknown> | null> {
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const router = useRouter()

  return useCallback(
    async (updates, { failedTitle, refreshNav = false }) => {
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        })
        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
        if (!res.ok) {
          toast({
            title: failedTitle,
            description: settingsSaveErrorMessage(json, res.status, locale),
            variant: 'destructive',
          })
          return null
        }
        if (refreshNav) router.refresh()
        return json ?? {}
      } catch (err) {
        // A rejected fetch (offline, aborted) never reaches the !res.ok arm;
        // a controlled switch then simply stays put, so say why.
        toast({ title: failedTitle, description: getErrorMessage(err, { locale }), variant: 'destructive' })
        return null
      }
    },
    [locale, toast, router],
  )
}
