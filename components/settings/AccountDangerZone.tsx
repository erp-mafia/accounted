'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
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
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import {
  SettingsDangerZone,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'

interface Blocker {
  id: string
  name: string
}

export function AccountDangerZone() {
  const t = useTranslations('settings_account_danger')
  const tRetention = useTranslations('retention_notice')
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [blockers, setBlockers] = useState<Blocker[]>([])
  const [blockersLoading, setBlockersLoading] = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!cancelled) setEmail(user?.email ?? null)

      try {
        const res = await fetch('/api/company?owned=true&archived=false')
        if (res.ok) {
          const body = await res.json()
          if (!cancelled) setBlockers(body.data ?? [])
        }
      } finally {
        if (!cancelled) setBlockersLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

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
        const body = await response.json()
        // Precondition tripped mid-flow: refresh the list and show inline.
        setBlockers(body.blockers ?? [])
        setError(body.error || t('delete_failed_blockers'))
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

  const hasBlockers = blockers.length > 0
  const canDelete = !hasBlockers && !blockersLoading

  return (
    <>
      <SettingsDangerZone label={t('heading')}>
        {/* Owned companies block deletion: functional state, kept visible as
            rows (only the first row carries the label and the why-help). */}
        {hasBlockers &&
          blockers.map((b, i) => (
            <SettingsRow
              key={b.id}
              label={i === 0 ? t('blockers_title') : ''}
              help={i === 0 ? t('blockers_description') : undefined}
            >
              <span className="text-sm">{b.name}</span>
              <SettingsRowEnd>
                <Button variant="ghost" size="sm" asChild>
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
          <SettingsRowEnd>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/reports?type=sie">
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                {t('export_sie')}
              </Link>
            </Button>
            <button
              type="button"
              onClick={() => setShowDialog(true)}
              disabled={!canDelete}
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
            <Label htmlFor="delete-confirm">
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
