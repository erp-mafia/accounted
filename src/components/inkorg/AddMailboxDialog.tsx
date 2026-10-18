'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { copyInboxAddress, type AddressCopyState } from '@/components/extensions/general/inbox-address-copy'
import { MAIL_SETTINGS_HREF, summarizeMailboxes } from '@/components/extensions/general/mail-connections'
import { useMailConnections } from '@/components/extensions/general/use-mail-connections'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { mailboxEntries, type MailboxDoor } from '@/lib/inkorg/mailboxes'
import { DoorMark } from './door-icon'

type AddressState =
  | { status: 'loading' }
  | { status: 'ready'; address: string }
  /** 404: no address provisioned yet, the one case where creating one retires nothing. */
  | { status: 'none' }
  /** Any other answer: we do not know whether an address exists, so nothing may create one. */
  | { status: 'failed' }

/**
 * Lägg till brevlåda: every door a document can come in through, with how
 * to connect it, each over the path that already exists (the intake address
 * here, the WhatsApp, Peppol and Gmail pages under Kopplingar). Billo and
 * Kivra are named and not built: coming soon, not clickable.
 */
export function AddMailboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('inkorg')
  const entries = mailboxEntries({
    whatsapp: ENABLED_EXTENSION_IDS.has('whatsapp-inbox'),
    mail: ENABLED_EXTENSION_IDS.has('mail'),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('add_mailbox')}</DialogTitle>
          <DialogDescription>{t('add_mailbox_intro')}</DialogDescription>
        </DialogHeader>
        {/* Radix mounts the body only while open, so each open reads the doors' states anew. */}
        <ul className="border-t border-border">
          {entries.map((entry) =>
            entry.comingSoon ? (
              <MailboxRow key={entry.door} door={entry.door} muted>
                <Badge variant="secondary" className="text-[11px]">
                  {t('coming_soon')}
                </Badge>
              </MailboxRow>
            ) : entry.door === 'intake_email' ? (
              <IntakeAddressRow key={entry.door} />
            ) : entry.door === 'whatsapp' ? (
              <WhatsAppRow key={entry.door} />
            ) : entry.door === 'mailbox' ? (
              <GmailRow key={entry.door} />
            ) : (
              <MailboxRow key={entry.door} door={entry.door}>
                <Button asChild variant="secondary" size="sm">
                  <Link href="/settings/peppol">{t('open')}</Link>
                </Button>
              </MailboxRow>
            ),
          )}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

function MailboxRow({
  door,
  detail,
  muted = false,
  children,
}: {
  door: MailboxDoor
  /** Replaces the door's one-line description (the address itself, a connected number). */
  detail?: ReactNode
  muted?: boolean
  children?: ReactNode
}) {
  const t = useTranslations('inkorg')
  return (
    <li className="flex items-center gap-4 border-b border-border py-3">
      <DoorMark door={door} size={28} className={muted ? 'opacity-50 grayscale' : undefined} />
      <div className={muted ? 'min-w-0 flex-1 text-muted-foreground' : 'min-w-0 flex-1'}>
        <p className="text-[13px] font-medium">{t(`mailbox_${door}_name`)}</p>
        <div className="text-[12.5px] text-muted-foreground">{detail ?? t(`mailbox_${door}_body`)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </li>
  )
}

function IntakeAddressRow() {
  const t = useTranslations('inkorg')
  const locale = useLocale()
  const { toast } = useToast()
  const [state, setState] = useState<AddressState>({ status: 'loading' })
  const [copy, setCopy] = useState<AddressCopyState>('idle')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/address')
      if (res.ok) {
        const json = (await res.json()) as { data?: { address?: string } }
        setState(json.data?.address ? { status: 'ready', address: json.data.address } : { status: 'failed' })
        return
      }
      setState(res.status === 404 ? { status: 'none' } : { status: 'failed' })
    } catch {
      setState({ status: 'failed' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onCopy(address: string) {
    // The clipboard write first: after another await it runs outside the click's user activation.
    setCopy(await copyInboxAddress(address))
  }

  async function onCreate() {
    setCreating(true)
    try {
      // The same call the workspace makes to activate an address. Only offered on a 404,
      // where there is no live address for it to retire.
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/rotate', { method: 'POST' })
      if (!res.ok) {
        toast({ title: t('address_create_failed'), description: await getResponseErrorMessage(res, undefined, locale === 'en' ? 'en' : 'sv'), variant: 'destructive' })
        return
      }
      await load()
    } finally {
      setCreating(false)
    }
  }

  if (state.status === 'loading') {
    return (
      <MailboxRow door="intake_email" detail={<Skeleton className="mt-1 h-4 w-48 rounded-sm" />} />
    )
  }
  if (state.status === 'failed') {
    return <MailboxRow door="intake_email" detail={<AttnLine>{t('address_load_failed')}</AttnLine>} />
  }
  if (state.status === 'none') {
    return (
      <MailboxRow door="intake_email">
        <Button size="sm" onClick={() => void onCreate()} loading={creating}>
          {t('address_create')}
        </Button>
      </MailboxRow>
    )
  }
  return (
    <MailboxRow
      door="intake_email"
      detail={
        <>
          <code data-ph-mask="" className="break-all text-[12.5px] text-foreground">
            {state.address}
          </code>
          {copy === 'failed' && <AttnLine>{t('address_copy_failed')}</AttnLine>}
        </>
      }
    >
      <Button variant="secondary" size="sm" onClick={() => void onCopy(state.address)}>
        {copy === 'copied' ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
        {copy === 'copied' ? t('copied') : t('copy')}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copy === 'copied' ? t('copied') : ''}
      </span>
    </MailboxRow>
  )
}

function WhatsAppRow() {
  const t = useTranslations('inkorg')
  const [linked, setLinked] = useState<{ linked: boolean; phoneMasked?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/extensions/ext/whatsapp-inbox/link')
        if (!res.ok) return
        const json = (await res.json()) as { data?: { linked: boolean; phoneMasked?: string } }
        if (!cancelled && json.data) setLinked(json.data)
      } catch {
        // The link to the page still works; only the state is unknown.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <MailboxRow
      door="whatsapp"
      detail={linked?.linked ? t('whatsapp_linked', { phone: linked.phoneMasked ?? '' }) : undefined}
    >
      <Button asChild variant={linked?.linked ? 'secondary' : 'default'} size="sm">
        <Link href="/settings/whatsapp">{linked?.linked ? t('open') : t('connect')}</Link>
      </Button>
    </MailboxRow>
  )
}

function GmailRow() {
  const t = useTranslations('inkorg')
  const tMail = useTranslations('mail')
  const mail = useMailConnections(true)
  const summary = summarizeMailboxes(mail.view)

  if (mail.loading) return <MailboxRow door="mailbox" detail={<Skeleton className="mt-1 h-4 w-48 rounded-sm" />} />

  const connected = summary.active.length > 0
  // A page that cannot connect anything is a dead end: then the row says so instead of linking there.
  // A failed read knows nothing about that, so it keeps the link.
  if (mail.view && !connected && !summary.available) {
    return <MailboxRow door="mailbox" detail={mail.view?.configured === false ? tMail('not_configured') : tMail('connect_closed')} />
  }
  return (
    <MailboxRow door="mailbox" detail={connected ? t('gmail_connected', { count: summary.active.length }) : undefined}>
      <Button asChild variant={connected ? 'secondary' : 'default'} size="sm">
        <Link href={MAIL_SETTINGS_HREF}>{connected ? t('open') : t('connect')}</Link>
      </Button>
    </MailboxRow>
  )
}
