'use client'

import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { SettingsRow, SettingsRowEnd } from '@/components/settings/SettingsRows'
import { saveFabHidden, storedFabHidden, type FabKind } from '@/lib/ui-state/fab-preference'

// Per-user toggle for the floating button bottom-right, a row of Ditt konto
// (/settings/account): the built-in assistant's button, or with `support`
// the support's, which holds the corner in a company without that assistant
// (components/support/SupportDock.tsx). Each button has its own stored
// choice (lib/ui-state/fab-preference.ts). The value
// lives on user_preferences (server-rendered into the dashboard layout), so
// a successful save triggers router.refresh() to make the button react
// immediately instead of on next navigation.
export function FabVisibilityRow({ support = false }: { support?: boolean }) {
  const t = useTranslations('settings_assistant')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const router = useRouter()
  // null = the value is not known: still loading, or the read failed (loadError).
  const [hideFab, setHideFab] = useState<boolean | null>(null)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const errorId = useId()
  const title = t(support ? 'fab_support_title' : 'fab_title')
  const kind: FabKind = support ? 'support' : 'assistant'

  // A settings row that cannot read its own value must not render one.
  // Defaulting to false on a failed GET drew a loaded-looking, interactive
  // switch in the "assistant button visible" position whatever the stored
  // preference was, and here that claim is contradicted on screen: the button
  // is server-rendered from the same column in the dashboard layout, so an
  // empty corner sat next to a switch insisting it was on.
  //
  // So the unknown value stays unknown: the switch keeps its disabled state and
  // one line says the value could not be read. 401/403 is the only case where
  // the reason changes what the user must do, so that message (from the same
  // status map the save path uses) replaces the retry instead of sitting next
  // to it; everything else is transient and the retry is the whole answer.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadError(null)
      try {
        const res = await fetch('/api/user/preferences')
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const body = await res.json().catch(() => null)
          if (cancelled) return
          const sessionGone = res.status === 401 || res.status === 403
          setHideFab(null)
          setLoadError({
            detail: sessionGone
              ? getErrorMessage(body, { statusCode: res.status, locale: errorLocale })
              : null,
          })
          return
        }
        // A 200 whose body will not parse is a failed read too: let it land in
        // the catch below rather than become a fabricated `false`.
        const body = await res.json()
        if (!cancelled) setHideFab(storedFabHidden(kind, body?.data))
      } catch {
        if (!cancelled) {
          setHideFab(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey, errorLocale, kind])

  // Rolling the switch back is necessary but not sufficient: a switch that
  // flips and flips again reads as a broken control, not as a refused save, so
  // the user retries the same click instead of signing in again (401 on an
  // expired session is by far the likeliest refusal here, and the status map
  // says exactly that). One toast per failed click, never two: TOAST_LIMIT is
  // 1 (components/ui/use-toast.tsx) and a second would evict the first.
  //
  // Only the fetch sits inside the try. A router.refresh() that threw must not
  // roll the switch back and claim the save failed, because by then the write
  // has landed.
  async function handleToggle(showFab: boolean) {
    const nextHide = !showFab
    const previous = hideFab
    setHideFab(nextHide)
    setSaving(true)
    try {
      const res = await saveFabHidden(kind, nextHide)
      if (!res.ok) {
        // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
        // getErrorMessage falls back to the status map.
        const body = await res.json().catch(() => null)
        setHideFab(previous)
        toast({
          title: t('fab_save_failed'),
          description: getErrorMessage(body, {
            statusCode: res.status,
            locale: errorLocale,
          }),
          variant: 'destructive',
        })
        return
      }
    } catch (err) {
      setHideFab(previous)
      toast({
        title: t('fab_save_failed'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
      return
    } finally {
      setSaving(false)
    }
    router.refresh()
  }

  return (
    <SettingsRow label={title} help={t(support ? 'fab_support_description' : 'fab_description')}>
      {/* Live region always mounted so the failure is announced when it
          appears, not merely inserted. */}
      <div id={errorId} role="status" aria-live="polite" className="min-w-0">
        {loadError && (
          <AttnLine
            action={
              loadError.detail
                ? undefined
                : { label: t('fab_load_retry'), onClick: () => setReloadKey((k) => k + 1) }
            }
          >
            {loadError.detail
              ? `${t('fab_load_failed')} ${loadError.detail}`
              : t('fab_load_failed')}
          </AttnLine>
        )}
      </div>
      <SettingsRowEnd>
        <Switch
          checked={hideFab === null ? true : !hideFab}
          onCheckedChange={handleToggle}
          disabled={hideFab === null || saving}
          aria-label={title}
          aria-describedby={loadError ? errorId : undefined}
        />
      </SettingsRowEnd>
    </SettingsRow>
  )
}
