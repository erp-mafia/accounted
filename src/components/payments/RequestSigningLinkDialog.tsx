'use client'

import { useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { AttnLine } from '@/components/ui/attn-line'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatCurrency } from '@/lib/utils'
import { PaymentsClientError } from './payments-client'
import { cancelSigningLink, issueSigningLink, type IssuedSigningLink, type OpenSigningLink } from './signing-links-client'

/** What the dialog needs per order: the rest stays on the server. */
export interface SigningLinkOrderSummary {
  id: string
  payee_name: string
  amount: number
  currency: string
}

const NOTE_MAX = 500
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface RequestSigningLinkPanelProps {
  /** Approved orders from one account in one currency (the server refuses otherwise). */
  orders: SigningLinkOrderSummary[]
  onClose: () => void
  /** Called once the link exists, mailed or not. */
  onIssued?: (link: IssuedSigningLink) => void
  /** Render the title and description here: true inside a dialog that has none of its own for this step. */
  withHeader?: boolean
}

/**
 * Be någon annan signera: e-post, an optional message, then Skicka länk (the
 * link is mailed) or Kopiera länk (the link is made and copied, for the
 * sender's own channel). Either way the URL is shown with a copy button. The
 * person who gets it signs the approved payments with BankID at
 * /betala/<token> without an Accounted login; the link holds 72 hours.
 */
export function RequestSigningLinkPanel({ orders, onClose, onIssued, withHeader = false }: RequestSigningLinkPanelProps) {
  const t = useTranslations('payment_signing_link')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'send' | 'copy' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedSigningLink | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  const total = useMemo(() => orders.reduce((sum, o) => sum + Number(o.amount), 0), [orders])
  const currency = orders[0]?.currency ?? 'SEK'
  const trimmedEmail = email.trim()
  const emailValid = trimmedEmail.length === 0 || EMAIL_RE.test(trimmedEmail)

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: t('copied') })
    } catch {
      toast({ title: t('copy_failed'), variant: 'destructive' })
    }
  }

  async function issue(mode: 'send' | 'copy') {
    if (mode === 'send' && (!trimmedEmail || !emailValid)) return
    setBusy(mode)
    setError(null)
    try {
      const link = await issueSigningLink({
        orderIds: orders.map((o) => o.id),
        recipientEmail: mode === 'send' ? trimmedEmail : null,
        note: note.trim() || null,
      })
      setIssued(link)
      setSentTo(mode === 'send' && link.email_sent ? trimmedEmail : null)
      if (mode === 'send' && !link.email_sent) setError(t('mail_not_sent'))
      onIssued?.(link)
      if (mode === 'copy') await copyUrl(link.url)
    } catch (err) {
      const body = err instanceof PaymentsClientError ? err.body : null
      setError(getErrorMessage(body, { locale, fallback: t('create_failed') }))
    } finally {
      setBusy(null)
    }
  }

  const header = withHeader ? (
    <DialogHeader>
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description', { count: orders.length, total: formatCurrency(total, currency) })}</DialogDescription>
    </DialogHeader>
  ) : null

  if (issued) {
    return (
      <div className="space-y-4">
        {header}
        <p className="text-[13px] leading-relaxed">{sentTo ? t('sent_to', { email: sentTo }) : t('created')}</p>
        <div className="flex items-center gap-2">
          <Input readOnly value={issued.url} aria-label={t('link_label')} className="font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />
          <Button variant="secondary" size="sm" onClick={() => copyUrl(issued.url)}>
            {t('copy')}
          </Button>
        </div>
        {error && <AttnLine>{error}</AttnLine>}
        <p className="text-[12.5px] text-muted-foreground">{t('valid_hours')}</p>
        <DialogFooter>
          <Button onClick={onClose}>{t('close')}</Button>
        </DialogFooter>
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void issue('send')
      }}
    >
      {header}
      <label className="block space-y-2 text-[13px]">
        <span className="text-muted-foreground">{t('email_label')}</span>
        <Input
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('email_placeholder')}
          aria-invalid={!emailValid || undefined}
          aria-describedby="payment-signing-link-email-hint"
        />
        <span id="payment-signing-link-email-hint" className="block text-[12.5px] text-muted-foreground">
          {t('email_hint')}
        </span>
      </label>
      <label className="block space-y-2 text-[13px]">
        <span className="text-muted-foreground">{t('note_label')}</span>
        <Textarea value={note} maxLength={NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} placeholder={t('note_placeholder')} />
      </label>
      <p className="text-[12.5px] text-muted-foreground">{t('valid_hours')}</p>
      {error && <AttnLine>{error}</AttnLine>}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy !== null}>
          {t('cancel')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => issue('copy')} loading={busy === 'copy'} disabled={busy !== null || !emailValid}>
          {t('copy_link')}
        </Button>
        <Button type="submit" loading={busy === 'send'} disabled={busy !== null || !trimmedEmail || !emailValid}>
          {t('send')}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The panel in its own centered dialog: from the selection bar on Betalningar and after Godkänn. */
export function RequestSigningLinkDialog({
  orders,
  onOpenChange,
  onIssued,
}: {
  orders: SigningLinkOrderSummary[]
  onOpenChange: (open: boolean) => void
  onIssued?: (link: IssuedSigningLink) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <RequestSigningLinkPanel orders={orders} onClose={() => onOpenChange(false)} onIssued={onIssued} withHeader />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The secondary action that opens the request: "Be någon annan signera", or
 * "Godkänn och be någon annan signera" where it also approves the drafts.
 */
export function RequestSigningLinkButton({
  label = 'request',
  onClick,
  loading = false,
  disabled = false,
  size,
  variant = 'secondary',
}: {
  label?: 'request' | 'approve_and_request'
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  size?: 'sm'
  variant?: 'default' | 'secondary' | 'outline'
}) {
  const t = useTranslations('payment_signing_link')
  return (
    <Button type="button" variant={variant} size={size} onClick={onClick} loading={loading} disabled={disabled}>
      {t(label === 'approve_and_request' ? 'approve_and_request' : 'request')}
    </Button>
  )
}

/**
 * On an order row while an open link covers it: "Väntar på signering av
 * {email}" and Avbryt länken. Muted text, not a chip: the order is approved
 * and waits, the link only says by whom.
 */
export function SigningLinkRowNote({ link, canCancel, onCancelled }: { link: OpenSigningLink; canCancel: boolean; onCancelled: () => void }) {
  const t = useTranslations('payment_signing_link')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  async function cancel() {
    setBusy(true)
    try {
      await cancelSigningLink(link.signing_link_id)
      toast({ title: t('cancelled') })
      onCancelled()
    } catch (err) {
      const body = err instanceof PaymentsClientError ? err.body : null
      toast({ title: t('cancel_link_failed'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="ml-2 inline-flex items-center gap-2 text-[11px] text-muted-foreground">
      <span data-ph-mask="">{link.recipient_email ? t('waiting_for', { email: link.recipient_email }) : t('waiting_for_link')}</span>
      {canCancel && (
        <button type="button" className={QUIET_LINK_CLASS} onClick={cancel} disabled={busy}>
          {t('cancel_link')}
        </button>
      )}
    </span>
  )
}
