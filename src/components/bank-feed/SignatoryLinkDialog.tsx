'use client'

import { useCallback, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { OPEN_PAYMENTS_SESSION_BASE, OpenPaymentsClientError } from './open-payments-client'

export interface SignatoryLinkOptions {
  /** The bank the link is for, when the row names one. */
  bank?: { bic: string | null; name: string | null } | null
  /** The connection the new one takes over from (a switch from Enable Banking, or a renewal). */
  replaceConnectionId?: string | null
}

export interface SignatoryLinkFlow {
  session: { key: number; options: SignatoryLinkOptions } | null
  open: (options?: SignatoryLinkOptions) => void
  close: () => void
}

/** The state behind one Skicka länk till firmatecknare dialog; entry points call `open(options)` and render the dialog once. */
export function useSignatoryLinkFlow(): SignatoryLinkFlow {
  const [session, setSession] = useState<SignatoryLinkFlow['session']>(null)
  const open = useCallback((options: SignatoryLinkOptions = {}) => setSession({ key: Date.now(), options }), [])
  const close = useCallback(() => setSession(null), [])
  return { session, open, close }
}

interface IssuedLink {
  url: string
  expires_at: string
  email_sent: boolean
}

async function issueLink(body: Record<string, unknown>): Promise<IssuedLink> {
  const res = await fetch(`${OPEN_PAYMENTS_SESSION_BASE}/invites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  if (!res.ok) throw new OpenPaymentsClientError(parsed, res.status)
  return (parsed as { data: IssuedLink }).data
}

/**
 * Skicka länk till firmatecknare: the small dialog beside Koppla bank and
 * Byt till ny koppling. An email sends the link by mail; without one the link
 * is only created. Either way the URL is shown with a copy button, so the
 * sender can pass it on in their own channel. The link is valid 7 days.
 */
export function SignatoryLinkDialog({ flow }: { flow: SignatoryLinkFlow }) {
  if (!flow.session) return null
  return <SignatoryLinkDialogInner key={flow.session.key} options={flow.session.options} onClose={flow.close} />
}

function SignatoryLinkDialogInner({ options, onClose }: { options: SignatoryLinkOptions; onClose: () => void }) {
  const t = useTranslations('bank_connect_invite')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [email, setEmail] = useState('')
  const [offerPayments, setOfferPayments] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedLink | null>(null)

  const trimmedEmail = email.trim()
  const emailValid = trimmedEmail.length === 0 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
  const bankName = options.bank?.name?.trim() || null

  async function submit() {
    if (!emailValid) return
    setBusy(true)
    setError(null)
    try {
      const link = await issueLink({
        bic: options.bank?.bic || null,
        replace_connection_id: options.replaceConnectionId ?? null,
        offer_payments: offerPayments,
        recipient_email: trimmedEmail || null,
        bank_name: bankName,
      })
      setIssued(link)
      if (trimmedEmail && !link.email_sent) setError(t('mail_not_sent'))
    } catch (err) {
      const body = err instanceof OpenPaymentsClientError ? err.body : null
      setError(getErrorMessage(body, { locale, fallback: t('create_failed') }))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.url)
      toast({ title: t('copied') })
    } catch {
      toast({ title: t('copy_failed'), variant: 'destructive' })
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{bankName ? t('description_bank', { bank: bankName }) : t('description')}</DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="space-y-4">
            <p className="text-[13px] leading-relaxed">{issued.email_sent ? t('sent_to', { email: trimmedEmail }) : t('created')}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={issued.url} aria-label={t('link_label')} className="font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" size="sm" onClick={copy}>
                {t('copy')}
              </Button>
            </div>
            {error && <AttnLine>{error}</AttnLine>}
            <p className="text-[12.5px] text-muted-foreground">{t('valid_days')}</p>
            <DialogFooter>
              <Button onClick={onClose}>{t('close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <label className="block space-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('email_label')}</span>
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('email_placeholder')}
                aria-invalid={!emailValid || undefined}
                aria-describedby="signatory-link-email-hint"
              />
              <span id="signatory-link-email-hint" className="block text-[12.5px] text-muted-foreground">
                {t('email_hint')}
              </span>
            </label>
            <label className="flex items-start gap-3 text-[13px]">
              <Checkbox checked={offerPayments} onCheckedChange={(checked) => setOfferPayments(checked === true)} className="mt-1" />
              <span>
                <span className="block">{t('offer_payments')}</span>
                <span className="block text-[12.5px] text-muted-foreground">{t('offer_payments_hint')}</span>
              </span>
            </label>
            <p className="text-[12.5px] text-muted-foreground">{t('valid_days')}</p>
            {error && <AttnLine>{error}</AttnLine>}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button type="submit" loading={busy} disabled={!emailValid}>
                {trimmedEmail ? t('send') : t('create_link')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
