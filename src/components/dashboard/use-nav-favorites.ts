'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { NAV_FAVORITES_CAP, storedFavorites, toggleFavorite } from '@/lib/navigation/favorites'
import { saveUiState } from '@/lib/ui-state/client'
import { createOrderedSave } from '@/lib/ui-state/ordered-save'

/**
 * The person's favourite menu rows (lib/navigation/favorites.ts) as the
 * sidebar holds them: the stored hrefs, and what a press on a row's star
 * does.
 *
 * `initial` is the list the layout read with the page
 * (ui_state.nav_favorites), so the Favoriter group is there on first paint.
 * A press shows at once and is stored after. The list is stored whole, so
 * the saves go out one at a time and in order (lib/ui-state/ordered-save.ts).
 * A refused save puts back the last list the server took and says so in a
 * toast. A press on a full list stores nothing and says how many there can
 * be.
 */
export function useNavFavorites(initial: readonly string[] | undefined): {
  /** Every stored favourite, also the ones the open company's menu does not show. */
  stored: string[]
  toggle: (href: string) => void
} {
  const t = useTranslations('nav')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const fromPage = useMemo(() => storedFavorites(initial), [initial])
  // The list after this tab's own presses; null until the first one, and
  // again when the first save was refused.
  const [pressed, setPressed] = useState<string[] | null>(null)
  const [save] = useState(() => createOrderedSave<string[]>((list) => saveUiState({ nav_favorites: list })))
  const stored = pressed ?? fromPage

  const toggle = (href: string) => {
    const next = toggleFavorite(stored, href)
    if (next === null) {
      toast({ title: t('v3_favorites_full', { max: NAV_FAVORITES_CAP }) })
      return
    }
    setPressed(next)
    void save(next, async ({ lastSaved, response, error }) => {
      setPressed(lastSaved ?? null)
      const body: unknown = response ? await response.json().catch(() => null) : error
      toast({
        title: t('v3_favorites_save_failed'),
        description: getErrorMessage(body, { statusCode: response?.status, locale: errorLocale }),
        variant: 'destructive',
      })
    })
  }

  return { stored, toggle }
}
