'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { filedVatPeriodsInRefusal } from '@/lib/settings/filed-vat-question'
import { settingsSaveErrorMessage } from '@/lib/settings/save-error'
import type { CompanySettings } from '@/types'

type SettingsBody = Record<string, unknown>

export interface SaveSettingsOptions {
  /** The toast title when the save fails. */
  failedTitle: string
  /**
   * The setting gates a nav row (Körjournal, Kundorder, Dimensioner,
   * Offerter): the nav is rendered by the server layout, so the page is
   * refreshed after the save or the row stays as it was until a reload.
   */
  refreshNav?: boolean
  /**
   * Asks the person before a lock date move reopens filed momsperioder: the
   * save is refused with their labels (lib/settings/filed-vat-question.ts),
   * true sends it again with the acknowledgment, false saves nothing and
   * shows nothing. Without it that refusal is shown like any other.
   */
  confirmReopeningFiledVat?: (periods: string[]) => Promise<boolean>
}

/**
 * One PUT /api/settings that never throws: the response body, and for a
 * refusal or a dropped connection the sentence that says why
 * (settingsSaveErrorMessage: the field rules for a validation refusal, the
 * envelope's message otherwise). A rejected fetch (offline, aborted) has no
 * response at all, so it is given its sentence here too.
 */
async function putSettings(
  updates: SettingsBody,
  locale: ErrorLocale,
): Promise<{ body: SettingsBody | null; failure: string | null }> {
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const body = (await res.json().catch(() => null)) as SettingsBody | null
    return { body, failure: res.ok ? null : settingsSaveErrorMessage(body, res.status, locale) }
  } catch (err) {
    return { body: null, failure: getErrorMessage(err, { locale }) }
  }
}

/**
 * The one PUT /api/settings for a settings control: sends the patch, and on a
 * refusal or a dropped connection shows the server's own sentence under
 * `failedTitle` (a controlled switch then simply stays put, so say why).
 * Resolves to the response body on success and null on failure; the caller
 * patches its settings state with what it sent. Eighteen controls used to
 * write this themselves, and the copies had drifted: some showed no reason
 * at all, one rendered the error envelope as "[object Object]".
 */
export function useSaveSettings(): (
  updates: Partial<CompanySettings>,
  options: SaveSettingsOptions,
) => Promise<Record<string, unknown> | null> {
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const router = useRouter()

  return useCallback(
    async (updates, { failedTitle, refreshNav = false, confirmReopeningFiledVat }) => {
      let answer = await putSettings(updates, locale)
      const reopened = answer.failure ? filedVatPeriodsInRefusal(answer.body) : null
      if (reopened && confirmReopeningFiledVat) {
        if (!(await confirmReopeningFiledVat(reopened))) return null
        answer = await putSettings({ ...updates, acknowledge_filed_vat_periods: true }, locale)
      }
      if (answer.failure) {
        toast({ title: failedTitle, description: answer.failure, variant: 'destructive' })
        return null
      }
      if (refreshNav) router.refresh()
      return answer.body ?? {}
    },
    [locale, toast, router],
  )
}

/**
 * The same PUT for a save that lives in a dialog (the Moms page's "Lås
 * bokföringen"): saved answers null, and a refusal answers the server's
 * sentence, for the dialog footer, where the action is. A toast would speak
 * for the wrong place.
 */
export async function saveSettingsInDialog(
  updates: Partial<CompanySettings>,
  locale: ErrorLocale,
): Promise<string | null> {
  return (await putSettings(updates, locale)).failure
}
