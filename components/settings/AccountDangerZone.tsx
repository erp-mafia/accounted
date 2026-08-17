'use client'

import { useState, useEffect, useId } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RetentionNotice } from '@/components/ui/retention-notice'
import { ExternalLink, Loader2 } from 'lucide-react'
import { SupportLink } from '@/components/ui/support-link'
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  canDeleteAccount,
  type OwnedCompanyBlocker,
} from '@/components/settings/account-deletion'
import {
  SettingsDangerZone,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'

export function AccountDangerZone() {
  const t = useTranslations('settings_account_danger')
  const tRetention = useTranslations('retention_notice')
  const errorLocale = useLocale() as ErrorLocale
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  // null = the blocker list is not known: still loading, or the read failed
  // (loadError). "Cannot read the blockers" must mean "cannot permit
  // deletion", never "no blockers": canDeleteAccount() only unlocks the
  // button for a confirmed empty list.
  const [blockers, setBlockers] = useState<OwnedCompanyBlocker[] | null>(null)
  // detail === null: transient, so the line carries a retry. A detail sentence
  // means the user has to act (an expired session) and a retry cannot help.
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [showDialog, setShowDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadError(null)
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!cancelled) setEmail(user?.email ?? null)

      try {
        const res = await fetch('/api/company?owned=true&archived=false')
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const body = await res.json().catch(() => null)
          if (cancelled) return
          const sessionGone = res.status === 401 || res.status === 403
          setBlockers(null)
          setLoadError({
            detail: sessionGone
              ? getUserErrorMessage(body, { statusCode: res.status, locale: errorLocale })
              : null,
          })
          return
        }
        // A 200 whose body will not parse throws into the catch below; a 200
        // whose data is not a list is a failed read too. Neither may become a
        // fabricated "no blockers".
        const body = await res.json()
        if (cancelled) return
        if (Array.isArray(body?.data)) {
          setBlockers(body.data)
        } else {
          setBlockers(null)
          setLoadError({ detail: null })
        }
      } catch {
        if (!cancelled) {
          setBlockers(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey, errorLocale])

  async function handleDelete() {
    if (!email) return
    if (confirmText.trim().toLowerCase() !== email.toLowerCase()) return

    setIsDeleting(true)
    setError(null)

    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_email: email }),
      })

      if (response.status === 409) {
        const body = await response.json().catch(() => null)
        // Precondition tripped mid-flow: refresh the list and show inline. A
        // 409 without a readable list still means blockers exist, so drop to
        // unknown (button stays locked) and re-read the authoritative list
        // instead of fabricating an empty one.
        if (Array.isArray(body?.blockers)) {
          setBlockers(body.blockers)
        } else {
          setBlockers(null)
          setReloadKey((k) => k + 1)
        }
        setError(
          typeof body?.error === 'string' && body.error
            ? body.error
            : t('delete_failed_blockers'),
        )
        setIsDeleting(false)
        setShowDialog(false)
        return
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || t('delete_failed_default'))
      }

      router.push('/login')
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : t('delete_failed_default'))
      setIsDeleting(false)
    }
  }

  const canDelete = canDeleteAccount(blockers)

  return (
    <>
      <SettingsDangerZone label={t('heading')}>
        {/* Owned companies block deletion: functional state, kept visible as
            rows (only the first row carries the label and the why-help). */}
        {blockers !== null &&
          blockers.map((b, i) => (
            <SettingsRow
              key={b.id}
              label={i === 0 ? t('blockers_title') : ''}
              help={i === 0 ? t('blockers_description') : undefined}
            >
              <span className="text-sm">{b.name}</span>
              <SettingsRowEnd>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/settings/company">{t('blockers_manage')}</Link>
                </Button>
              </SettingsRowEnd>
            </SettingsRow>
          ))}

        <SettingsRow
          label={t('delete_button')}
          borderless
          // The full anonymization/BFL retention copy (incl. the backup link)
          // lives behind the "?": the visible row stays one quiet line.
          help={<RetentionNotice variant="account" className="border-0 bg-transparent p-0" />}
        >
          <SettingsRowNote>{tRetention('account_title')}</SettingsRowNote>
          {/* Live region always mounted so the failure is announced when it
              appears, not merely inserted. */}
          <div id={errorId} role="status" aria-live="polite" className="min-w-0">
            {/* The button is disabled while companies remain, so the reason has
                to be visible next to it: hiding it behind the blocker row's "?"
                left users reading the greyed-out button as broken. */}
            {!loadError && blockers !== null && blockers.length > 0 && (
              <AttnLine>{t('blocked_reason', { count: blockers.length })}</AttnLine>
            )}
            {loadError && (
              <AttnLine
                action={
                  loadError.detail
                    ? undefined
                    : { label: t('blockers_load_retry'), onClick: () => setReloadKey((k) => k + 1) }
                }
              >
                {loadError.detail
                  ? `${t('blockers_load_failed')} ${loadError.detail}`
                  : t('blockers_load_failed')}
              </AttnLine>
            )}
          </div>
          <SettingsRowEnd>
            <Button variant="outline" size="sm" asChild>
              <Link href="/reports?type=sie">
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {t('export_sie')}
              </Link>
            </Button>
            <button
              type="button"
              onClick={() => setShowDialog(true)}
              disabled={!canDelete}
              aria-describedby={canDelete ? undefined : errorId}
              className="text-sm font-medium text-destructive underline underline-offset-2 transition-colors duration-150 hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('delete_button')}
            </button>
          </SettingsRowEnd>
        </SettingsRow>

        {error && !showDialog && (
          <p className="px-1 text-sm text-destructive">{error}</p>
        )}

        <p className="px-1 pt-3">
          <SettingsRowNote>
            {t('support_question')}{' '}
            <SupportLink variant="inline" subject={t('support_subject')} />
          </SettingsRowNote>
        </p>
      </SettingsDangerZone>

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (isDeleting) return
          setShowDialog(open)
          if (!open) {
            setConfirmText('')
            setError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog_title')}</DialogTitle>
            <DialogDescription>
              {t('dialog_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {/* data-ph-mask: the label interpolates the user's email */}
            <Label data-ph-mask="" htmlFor="delete-confirm">
              {t.rich('confirm_label', {
                email: email ?? '',
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </Label>
            <Input
              id="delete-confirm"
              type="email"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={email ?? ''}
              autoComplete="off"
              // ph-no-capture: the placeholder is the user's email, and
              // replay masking covers values, not attributes.
              className="ph-no-capture"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDialog(false)
                setConfirmText('')
                setError(null)
              }}
              disabled={isDeleting}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={
                !email ||
                confirmText.trim().toLowerCase() !== email.toLowerCase() ||
                isDeleting
              }
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('delete_confirm_button')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
