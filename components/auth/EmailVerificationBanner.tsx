'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'

/**
 * Shown to a BankID account whose typed e-mail is still unproven
 * (app_metadata.bankid_pending; BankID instant login). BankID proved the
 * person, so they are signed in; the mail proves the mailbox, and until it
 * does the account cannot accept invites or receive company mail. The two
 * actions are the only recovery paths for a lost or mistyped address.
 *
 * Server-gated like SandboxBanner: the layouts render this only for pending
 * accounts. Same chrome treatment (secondary surface, never a warning fill).
 */
export function EmailVerificationBanner({ email }: { email: string }) {
  const t = useTranslations('email_verification')
  const [currentEmail, setCurrentEmail] = useState(email)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  async function post(path: string, body?: unknown) {
    const res = await fetch(`/api/extensions/ext/tic/bankid/pending/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const json = (await res.json().catch(() => ({}))) as {
      error?: string
      data?: { email?: string }
    }
    return { ok: res.ok, status: res.status, json }
  }

  async function resend() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { ok, json } = await post('resend')
      if (ok) {
        setNotice(t('sent', { email: currentEmail }))
      } else if (json.error === 'cooldown') {
        setError(t('error_cooldown'))
      } else {
        setError(t('error_generic'))
      }
    } catch {
      setError(t('error_generic'))
    } finally {
      setBusy(false)
    }
  }

  async function saveAddress(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const next = draft.trim().toLowerCase()
    if (!next) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { ok, status, json } = await post('change-email', { email: next })
      if (ok) {
        setCurrentEmail(json.data?.email ?? next)
        setEditing(false)
        setDraft('')
        setNotice(t('changed', { email: json.data?.email ?? next }))
      } else if (json.error === 'account_exists') {
        setError(t('error_exists'))
      } else if (json.error === 'mail_failed') {
        // Address changed, mail did not go: keep the new address and let
        // the re-send button be the retry.
        setCurrentEmail(next)
        setEditing(false)
        setDraft('')
        setError(t('error_generic'))
      } else if (status === 400) {
        setError(t('error_invalid'))
      } else {
        setError(t('error_generic'))
      }
    } catch {
      setError(t('error_generic'))
    } finally {
      setBusy(false)
    }
  }

  const buttonClass =
    'shrink-0 rounded-full bg-foreground/10 px-3 py-0.5 text-xs font-semibold transition-colors hover:bg-foreground/15 disabled:opacity-50'

  return (
    <div
      role="status"
      className="relative z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-secondary px-10 py-2 text-sm text-secondary-foreground sm:px-4"
    >
      {editing ? (
        <form onSubmit={saveAddress} className="flex flex-wrap items-center justify-center gap-2">
          <label htmlFor="pending-email" className="text-xs font-medium sm:text-sm">
            {t('change_label')}
          </label>
          <input
            id="pending-email"
            type="email"
            required
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={currentEmail}
            className="h-7 w-56 rounded-lg border border-border bg-background px-2 text-xs sm:text-sm"
          />
          <button type="submit" disabled={busy} className={buttonClass}>
            {t('save')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(false)
              setDraft('')
              setError(null)
            }}
            className="text-xs underline-offset-2 hover:underline"
          >
            {t('cancel')}
          </button>
        </form>
      ) : (
        <>
          <span className="text-center text-xs font-medium sm:text-sm">
            {notice ?? t('banner', { email: currentEmail })}
          </span>
          <button type="button" disabled={busy} onClick={resend} className={buttonClass}>
            {t('resend')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(true)
              setNotice(null)
              setError(null)
            }}
            className="text-xs underline-offset-2 hover:underline"
          >
            {t('change')}
          </button>
        </>
      )}
      {error && (
        <span className="basis-full text-center text-xs text-destructive">{error}</span>
      )}
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 transition-colors hover:bg-foreground/10"
        aria-label={t('dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
