'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { saveFabHidden as storeFabHidden, type FabKind } from '@/lib/ui-state/fab-preference'
import { resolveFabOverride, type FabOverride } from './fab-override'

/**
 * A floating button's own X: it writes the opt-out the settings switch
 * writes (crm#245: that switch sits on a page the settings rail no longer
 * lists, so "turn it off in settings" was not a way a user could find), and
 * says so in a toast with an undo. `hiddenToast` is what the toast says:
 * where the thing the button led to is still found.
 *
 * Shared by the built-in assistant's button (AgentTrigger) and the support's
 * (components/support/SupportAskTrigger.tsx). `kind` says which: each has
 * its own stored choice (lib/ui-state/fab-preference.ts), so hiding the
 * assistant's button never hid the support's.
 *
 * The override hides or restores the button at once instead of waiting for
 * router.refresh() to re-render the layout. It is keyed to the prop value it
 * was set against, so once the server-rendered prop changes (the refresh, or
 * the settings switch), the prop is the truth again without an effect, also
 * when it later returns to that value (resolveFabOverride).
 */
export function useFabHidden(
  hidden: boolean,
  hiddenToast: { title: string; description: string },
  kind: FabKind = 'assistant',
): { effectiveHidden: boolean; hideFab: () => Promise<void> } {
  const t = useTranslations('settings_assistant')
  const errorLocale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const [hideOverride, setHideOverride] = useState<FabOverride | null>(null)
  const resolved = resolveFabOverride(hideOverride, hidden)
  // State adjusted while rendering, from the prop it follows (React's pattern
  // for state that depends on a changed prop); it settles in one pass.
  if (resolved.override !== hideOverride) setHideOverride(resolved.override)
  const effectiveHidden = resolved.effectiveHidden

  async function saveFabHidden(nextHide: boolean): Promise<boolean> {
    try {
      const res = await storeFabHidden(kind, nextHide)
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast({
          title: t('fab_save_failed'),
          description: getErrorMessage(body, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return false
      }
    } catch (err) {
      toast({
        title: t('fab_save_failed'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
      return false
    }
    // Outside the try: a refresh that throws must not report a failed save,
    // the write has landed by then.
    router.refresh()
    return true
  }

  // Runs from the toast's Ångra, a closure older than the refresh that hid the
  // button, so it cannot read the current prop. Undo only follows a saved
  // hide, so the stored value it overrides is "hidden"; before that refresh
  // lands the prop is still false and the button shows either way.
  async function restoreFab() {
    // Not armed: the prop may not have reached "hidden" yet.
    setHideOverride({ value: false, against: true, armed: false })
    if (!(await saveFabHidden(false))) setHideOverride(null)
  }

  async function hideFab() {
    setHideOverride({ value: true, against: hidden, armed: true })
    if (!(await saveFabHidden(true))) {
      setHideOverride(null)
      return
    }
    toast({
      title: hiddenToast.title,
      description: hiddenToast.description,
      action: (
        <ToastAction altText={t('fab_hidden_undo')} onClick={() => void restoreFab()}>
          {t('fab_hidden_undo')}
        </ToastAction>
      ),
    })
  }

  return { effectiveHidden, hideFab }
}
