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

interface Blocker {
  id: string
  name: string
}

export function AccountDangerZone() {
  const t = useTranslations('settings_account_danger')
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
      setError(err instanceof Error ? err.message : t('delete_failed_default'))
      setIsDeleting(false)
    }
  }

  const hasBlockers = blockers.length > 0
  const canDelete = !hasBlockers && !blockersLoading

  return (
    <>
      <section className="space-y-4 border-t border-border pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-destructive/80">
          {t('heading')}
        </h2>

        {hasBlockers && (
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
            <p className="text-sm font-medium">{t('blockers_title')}</p>
            <p className="text-sm text-muted-foreground">
              {t('blockers_description')}
            </p>
            <ul className="space-y-2">
              {blockers.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2"
                >
                  <span className="text-sm font-medium">{b.name}</span>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/settings/company">{t('blockers_manage')}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <RetentionNotice variant="account" />

        <p className="text-sm text-muted-foreground">
          {t('support_question')}{' '}
          <SupportLink variant="inline" subject={t('support_subject')} />
        </p>

        {error && !showDialog && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" className="w-full sm:w-auto" asChild>
            <Link href="/reports?type=sie">
              <ExternalLink className="mr-2 h-4 w-4" />
              {t('export_sie')}
            </Link>
          </Button>
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={() => setShowDialog(true)}
            disabled={!canDelete}
          >
            {t('delete_button')}
          </Button>
        </div>
      </section>

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
