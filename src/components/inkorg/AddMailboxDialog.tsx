'use client'

import { useCallback, useEffect, useId, useState, type ComponentType, type FormEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { CheckIcon, EllipsisHorizontalIcon, Square2StackIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { copyInboxAddress, type AddressCopyState } from '@/components/extensions/general/inbox-address-copy'
import { MAIL_SETTINGS_HREF, summarizeMailboxes } from '@/components/extensions/general/mail-connections'
import { RequestGmailAccessButton } from '@/components/extensions/general/RequestGmailAccessButton'
import { useMailConnections } from '@/components/extensions/general/use-mail-connections'
import type { ConnectionSummary } from '@/lib/digital-mailboxes/connections'
import { phoneToE164 } from '@/lib/digital-mailboxes/identifiers'
import type { DigitalMailboxAvailability } from '@/lib/digital-mailboxes/providers'
import type { SyncResult } from '@/lib/digital-mailboxes/receive'
import type { DigitalMailboxProviderId } from '@/lib/digital-mailboxes/types'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { getErrorMessage, getResponseErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { digitalMailboxRowView, type DigitalMailboxRowView, type DigitalMailboxSending } from '@/lib/inkorg/digital-mailbox-row'
import { mailboxEntries, type MailboxDoor } from '@/lib/inkorg/mailboxes'
import { formatDateTime } from '@/lib/utils'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { DoorMark } from './door-icon'

type AddressState =
  | { status: 'loading' }
  /**
   * carriesName: false once a rename left the address on the old name, null when unknown.
   * previous: earlier addresses a rename kept; they still receive.
   */
  | { status: 'ready'; address: string; carriesName: boolean | null; previous: string[] }
  /** 404: no address provisioned yet, the one case where creating one retires nothing. */
  | { status: 'none' }
  /** Any other answer: we do not know whether an address exists, so nothing may create one. */
  | { status: 'failed' }

/**
 * Lägg till brevlåda: every door a document can come in through, with how
 * to connect it, each over the path that already exists (the intake address
 * here, the WhatsApp, Peppol and Gmail pages under Kopplingar) or, for Kivra
 * and Billo, right in the row. Kivra and Billo are coming soon, not
 * clickable, in a deployment without Accounted's credentials for them.
 */
export function AddMailboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('inkorg')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{t('add_mailbox')}</DialogTitle>
          <DialogDescription>{t('add_mailbox_intro')}</DialogDescription>
        </DialogHeader>
        {/* Radix mounts the body only while open, so each open reads the doors' states anew. */}
        <MailboxList />
      </DialogContent>
    </Dialog>
  )
}

function MailboxList() {
  const t = useTranslations('inkorg')
  const digital = useDigitalMailboxes()
  // Until the answer is in, Kivra and Billo render as rows with a skeleton (or
  // a failed read's line): only a read that says so turns them into coming soon.
  const receives = (provider: DigitalMailboxProviderId) =>
    digital.state.status !== 'ready' || digital.state.providers[provider].available.receive
  const entries = mailboxEntries({
    whatsapp: ENABLED_EXTENSION_IDS.has('whatsapp-inbox'),
    mail: ENABLED_EXTENSION_IDS.has('mail'),
    kivra: receives('kivra'),
    billo: receives('billo'),
  })

  return (
    <ul className="border-t-hairline">
      {entries.map((entry) =>
        entry.comingSoon ? (
          <MailboxRow key={entry.door} door={entry.door} muted>
            <Badge variant="secondary" className="text-xs">
              {t('coming_soon')}
            </Badge>
          </MailboxRow>
        ) : entry.door === 'intake_email' ? (
          <IntakeAddressRow key={entry.door} />
        ) : entry.door === 'whatsapp' ? (
          <WhatsAppRow key={entry.door} />
        ) : entry.door === 'mailbox' ? (
          <GmailRow key={entry.door} />
        ) : entry.door === 'kivra' ? (
          <KivraRow key={entry.door} {...digital.rowProps('kivra')} />
        ) : entry.door === 'billo' ? (
          <BilloRow key={entry.door} {...digital.rowProps('billo')} />
        ) : (
          <MailboxRow key={entry.door} door={entry.door}>
            <Button asChild variant="outline">
              <Link href="/settings/peppol">{t('open')}</Link>
            </Button>
          </MailboxRow>
        ),
      )}
    </ul>
  )
}

function MailboxRow({
  door,
  detail,
  muted = false,
  extra,
  children,
}: {
  door: MailboxDoor
  /** Replaces the door's one-line description (the address itself, a connected number). */
  detail?: ReactNode
  muted?: boolean
  /** A quiet second line under the row, spanning the text and the actions (Kivra's and Billo's sending switch). */
  extra?: ReactNode
  children?: ReactNode
}) {
  const t = useTranslations('inkorg')
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b-hairline py-3">
      <DoorMark door={door} size={28} className={muted ? 'opacity-60' : undefined} />
      <div className={muted ? 'text-muted-foreground' : undefined}>
        <p className="text-[13px] font-medium">{t(`mailbox_${door}_name`)}</p>
        <div className="text-xs text-muted-foreground">{detail ?? t(`mailbox_${door}_body`)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
      {extra ? <div className="col-span-2 col-start-2">{extra}</div> : null}
    </li>
  )
}

function IntakeAddressRow() {
  const t = useTranslations('inkorg')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [state, setState] = useState<AddressState>({ status: 'loading' })
  const [copy, setCopy] = useState<AddressCopyState>('idle')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/address')
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { address?: string; carries_company_name?: boolean | null; previous?: string[] | null }
        }
        const data = json.data
        setState(
          data?.address
            ? {
                status: 'ready',
                address: data.address,
                carriesName: data.carries_company_name ?? null,
                previous: data.previous ?? [],
              }
            : { status: 'failed' },
        )
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

  async function onRename() {
    if (renaming) return
    setRenaming(true)
    try {
      // A new address with the company's current name; the old one keeps
      // receiving (rename_company_inbox), so suppliers can switch at their own pace.
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_previous: true }),
      })
      if (!res.ok) {
        toast({ title: t('address_rename_failed'), description: await getResponseErrorMessage(res, undefined, locale === 'en' ? 'en' : 'sv'), variant: 'destructive' })
        return
      }
      setCopy('idle')
      toast({ title: t('address_renamed') })
      await load()
    } finally {
      setRenaming(false)
    }
  }

  // An earlier address a rename kept (crm#1209): it stops receiving and leaves
  // the list; what came in through it stays.
  async function onStopPrevious(address: string) {
    const stopped = await confirm(
      {
        title: t('address_previous_stop_title', { address }),
        description: t('address_previous_stop_body'),
        confirmLabel: t('address_previous_stop'),
        cancelLabel: tCommon('cancel'),
      },
      async () => {
        const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/previous/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        })
        if (!res.ok) {
          const message = await getResponseErrorMessage(res, undefined, locale === 'en' ? 'en' : 'sv')
          toast({ title: t('address_previous_stop_failed'), description: message, variant: 'destructive' })
          // Keeps the confirm from resolving as done.
          throw new Error(message)
        }
      },
    )
    if (!stopped) return
    toast({ title: t('address_previous_stopped') })
    await load()
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
        <Button onClick={() => void onCreate()} loading={creating}>
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
          <code data-ph-mask="" className="break-all text-xs text-foreground">
            {state.address}
          </code>
          {copy === 'failed' && <AttnLine>{t('address_copy_failed')}</AttnLine>}
          {state.previous.map((previous) => (
            <p key={previous} className="mt-0.5 text-xs">
              {t('address_previous')}{' '}
              <code data-ph-mask="" className="break-all">
                {previous}
              </code>{' '}
              <button
                type="button"
                onClick={() => void onStopPrevious(previous)}
                aria-label={t('address_previous_stop_aria', { address: previous })}
                className="text-muted-foreground underline decoration-foreground/25 underline-offset-2 hover:text-foreground"
              >
                {t('address_previous_stop')}
              </button>
            </p>
          ))}
          {state.carriesName === false && (
            <AttnLine
              className="mt-0.5"
              action={{ label: renaming ? t('address_renaming') : t('address_rename'), onClick: () => void onRename() }}
            >
              {t('address_old_name')}
            </AttnLine>
          )}
        </>
      }
    >
      <Button variant="outline" onClick={() => void onCopy(state.address)}>
        {copy === 'copied' ? <CheckIcon className="h-3.5 w-3.5" /> : <Square2StackIcon className="h-3.5 w-3.5" />}
        {copy === 'copied' ? t('copied') : t('copy')}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copy === 'copied' ? t('copied') : ''}
      </span>
      <DestructiveConfirmDialog {...dialogProps} />
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
      <Button asChild variant={linked?.linked ? 'outline' : 'default'}>
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
    if (mail.view.configured === false) return <MailboxRow door="mailbox" detail={tMail('not_configured')} />
    // Closed for this company: not a dead end, a mail to us that opens it.
    return (
      <MailboxRow door="mailbox" detail={tMail('request_access')}>
        <RequestGmailAccessButton />
      </MailboxRow>
    )
  }
  return (
    <MailboxRow door="mailbox" detail={connected ? t('gmail_connected', { count: summary.active.length }) : undefined}>
      <Button asChild variant={connected ? 'outline' : 'default'}>
        <Link href={MAIL_SETTINGS_HREF}>{connected ? t('open') : t('connect')}</Link>
      </Button>
    </MailboxRow>
  )
}

// ---------------------------------------------------------------------------
// Kivra and Billo: the company's digital mailbox, connected in the row
// ---------------------------------------------------------------------------

interface DigitalProviderAnswer {
  available: DigitalMailboxAvailability
  connection: ConnectionSummary | null
}

type DigitalState =
  | { status: 'loading' }
  | { status: 'ready'; providers: Record<DigitalMailboxProviderId, DigitalProviderAnswer> }
  | { status: 'failed' }

type DigitalSlot = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; answer: DigitalProviderAnswer }

/**
 * What a Kivra or Billo row hands the frame that lays it out: this dialog's
 * list row, or a connection row on Inställningar › Kopplingar. The row owns
 * the state, the buttons and the dialogs; the frame only places them.
 */
export interface DigitalMailboxRowFrameProps {
  door: DigitalMailboxProviderId
  /** The mailbox's state in one line (read, waiting, loading, a failed read); absent while nothing reads it. */
  status?: ReactNode
  /** The mailbox is read into the Inkorg. */
  connected?: boolean
  /** Lines under the state: Billo's scanning address, the last failure. */
  notes?: ReactNode
  /** The sending switch. */
  extra?: ReactNode
  /** The row's buttons. */
  children?: ReactNode
}

export interface DigitalRowProps {
  slot: DigitalSlot
  /** Puts the connection a write answered in place, without another read. */
  onConnection: (connection: ConnectionSummary | null) => void
  /** Reads both providers again: a sync answers counts, not the connection. */
  reload: () => void
  /** The frame the row is laid out in; this dialog's list row when left out. */
  Row?: ComponentType<DigitalMailboxRowFrameProps>
  /** The look of the button that connects: the dialog's primary when left out, `outline` in a list of connections. */
  connectVariant?: 'default' | 'outline'
}

/** The frame in this dialog: the state and its notes take the place of the door's description. */
function DialogDigitalRow({ door, status, notes, extra, children }: DigitalMailboxRowFrameProps) {
  const detail =
    status || notes ? (
      <>
        {status ? <div>{status}</div> : null}
        {notes}
      </>
    ) : undefined
  return (
    <MailboxRow door={door} detail={detail} extra={extra}>
      {children}
    </MailboxRow>
  )
}

/** A failed read: a re-read after a write keeps what the rows already show. */
function failedRead(prev: DigitalState): DigitalState {
  return prev.status === 'ready' ? prev : { status: 'failed' }
}

/**
 * GET /api/digital-mailboxes, once per mount (each open of the dialog) and
 * again on reload(). With `enabled` false nothing is read and the state
 * stays loading: a page that shows the rows only to some companies does not
 * ask for the others.
 */
export function useDigitalMailboxes(enabled = true) {
  const [state, setState] = useState<DigitalState>({ status: 'loading' })
  const [reads, setReads] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/digital-mailboxes')
        const json = res.ok
          ? ((await res.json()) as { data?: { providers?: Partial<Record<DigitalMailboxProviderId, DigitalProviderAnswer>> } })
          : null
        const kivra = json?.data?.providers?.kivra
        const billo = json?.data?.providers?.billo
        if (!cancelled) setState((prev) => (kivra && billo ? { status: 'ready', providers: { kivra, billo } } : failedRead(prev)))
      } catch {
        if (!cancelled) setState(failedRead)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reads, enabled])

  const reload = useCallback(() => setReads((n) => n + 1), [])

  const setConnection = useCallback((provider: DigitalMailboxProviderId, connection: ConnectionSummary | null) => {
    setState((prev) =>
      prev.status === 'ready'
        ? { status: 'ready', providers: { ...prev.providers, [provider]: { ...prev.providers[provider], connection } } }
        : prev,
    )
  }, [])

  const rowProps = (provider: DigitalMailboxProviderId): Pick<DigitalRowProps, 'slot' | 'onConnection' | 'reload'> => ({
    slot: state.status === 'ready' ? { status: 'ready', answer: state.providers[provider] } : state,
    onConnection: (connection) => setConnection(provider, connection),
    reload,
  })

  return { state, rowProps }
}

type Answer<T> = { ok: true; data: T } | { ok: false; code: string | null; message: string }

/** One write to /api/digital-mailboxes/{path}: its data, or the refusal's code and its sentence for the person. */
async function mailboxRequest<T>(path: string, method: 'POST' | 'DELETE', locale: ErrorLocale, body?: unknown): Promise<Answer<T>> {
  try {
    const res = await fetch(`/api/digital-mailboxes/${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    // Read a copy: the response itself stays unread for getResponseErrorMessage.
    const json = (await res
      .clone()
      .json()
      .catch(() => null)) as { data?: T; error?: { code?: unknown } } | null
    if (res.ok && json?.data !== undefined) return { ok: true, data: json.data }
    const code = typeof json?.error?.code === 'string' ? json.error.code : null
    return { ok: false, code, message: await getResponseErrorMessage(res, undefined, locale) }
  } catch {
    return { ok: false, code: null, message: getErrorMessage(null, { locale }) }
  }
}

/** Only an https page is opened in a new tab. */
function httpsUrl(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.startsWith('https://') ? value : null
}

type DigitalBusy = 'connect' | 'sync' | 'sending' | null

/** What both rows do the same way: read now, disconnect, switch sending. */
function useDigitalMailboxActions(provider: DigitalMailboxProviderId, { onConnection, reload }: Pick<DigitalRowProps, 'onConnection' | 'reload'>) {
  const t = useTranslations('inkorg')
  const tCommon = useTranslations('common')
  const locale: ErrorLocale = useLocale() === 'en' ? 'en' : 'sv'
  const { toast } = useToast()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [busy, setBusy] = useState<DigitalBusy>(null)
  const name = t(`mailbox_${provider}_name`)

  /**
   * "Hämta nu", and Kivra's "Kontrollera" (`checking`): the sync route first
   * asks Kivra whether a waiting connection was activated. Not yet is no
   * failure: the row keeps waiting.
   */
  async function sync(checking: boolean): Promise<void> {
    setBusy('sync')
    const answer = await mailboxRequest<SyncResult>(`${provider}/sync`, 'POST', locale)
    setBusy(null)
    if (answer.ok) {
      const filed = t('digital_sync_done', { count: answer.data.filed })
      // What one run did not file (more waiting, or a document that failed) follows with the cron.
      const rest = answer.data.more || answer.data.failed > 0 ? t('digital_sync_more') : null
      toast(
        checking
          ? { title: t('kivra_activated'), description: rest ? `${filed} ${rest}` : filed }
          : { title: filed, description: rest ?? undefined },
      )
    } else if (checking && answer.code === 'DIGITAL_MAILBOX_NOT_CONNECTED') {
      toast({ title: t('kivra_not_active_yet') })
    } else {
      toast({ title: t('digital_sync_failed'), description: answer.message, variant: 'destructive' })
    }
    reload()
  }

  async function disconnect(): Promise<void> {
    await confirm(
      {
        title: t('digital_disconnect_title', { provider: name }),
        description: t(provider === 'kivra' ? 'digital_disconnect_kivra_body' : 'digital_disconnect_billo_body'),
        confirmLabel: t('digital_disconnect'),
        cancelLabel: tCommon('cancel'),
      },
      async () => {
        const answer = await mailboxRequest<{ connection: ConnectionSummary | null }>(`${provider}/receive`, 'DELETE', locale)
        if (!answer.ok) {
          toast({ title: t('digital_disconnect_failed', { provider: name }), description: answer.message, variant: 'destructive' })
          // Keeps the confirm from resolving as done.
          throw new Error(answer.message)
        }
        onConnection(answer.data.connection)
        toast({ title: t('digital_disconnected', { provider: name }) })
      },
    )
  }

  async function setSending(on: boolean): Promise<void> {
    setBusy('sending')
    const answer = await mailboxRequest<{ connection: ConnectionSummary | null }>(`${provider}/send`, on ? 'POST' : 'DELETE', locale)
    setBusy(null)
    if (!answer.ok) {
      toast({ title: t('digital_sending_failed'), description: answer.message, variant: 'destructive' })
      // A declined access request is recorded on the connection: the row says so from now on.
      if (answer.code === 'DIGITAL_MAILBOX_SENDER_REQUEST_REJECTED') reload()
      return
    }
    onConnection(answer.data.connection)
    if (on && answer.data.connection?.send_request === 'pending') {
      toast({ title: t('digital_sending_pending_title', { provider: name }), description: t('digital_sending_pending', { provider: name }) })
    }
  }

  return { t, name, locale, toast, busy, setBusy, sync, disconnect, setSending, dialogProps }
}

/** Before the answer is in, or when it never came: the row without its controls. */
function DigitalPlaceholderRow({
  door,
  status,
  Row,
}: {
  door: DigitalMailboxProviderId
  status: 'loading' | 'failed'
  Row: ComponentType<DigitalMailboxRowFrameProps>
}) {
  const t = useTranslations('inkorg')
  if (status === 'loading') return <Row door={door} status={<Skeleton className="mt-1 h-4 w-48 rounded-sm" />} />
  return <Row door={door} status={<AttnLine>{t('digital_load_failed')}</AttnLine>} />
}

/** The state of a mailbox that is read or waits, in one line. */
function DigitalStatus({ provider, view }: { provider: DigitalMailboxProviderId; view: DigitalMailboxRowView }) {
  const t = useTranslations('inkorg')
  if (view.receive === 'pending') return <>{t(provider === 'kivra' ? 'kivra_pending' : 'billo_pending')}</>
  return <>{view.lastSyncedAt ? t('digital_synced', { time: formatDateTime(view.lastSyncedAt) }) : t('digital_never_synced')}</>
}

/** Whether the mailbox has lines to show under its state. */
function hasDigitalNotes(view: DigitalMailboxRowView): boolean {
  return !!view.postalAddress || !!view.error
}

/** The lines under the state: Billo's scanning address and the last failure. */
function DigitalNotes({ provider, view }: { provider: DigitalMailboxProviderId; view: DigitalMailboxRowView }) {
  const t = useTranslations('inkorg')
  const name = t(`mailbox_${provider}_name`)
  return (
    <>
      {view.postalAddress && (
        <p data-ph-mask="" className="break-words">
          {t('billo_postal_address', { address: view.postalAddress })}
        </p>
      )}
      {view.error && (
        <AttnLine>
          {view.error.at
            ? t('digital_error', { provider: name, time: formatDateTime(view.error.at) })
            : t('digital_error_untimed', { provider: name })}
        </AttnLine>
      )}
    </>
  )
}

/**
 * The quiet second line: the company as a sender of invoices and payslips
 * through the provider. While the provider has an access request to decide
 * (the company already sends through another service) the switch stays on,
 * since that is what was asked for, and says it waits; switching it off
 * drops the request.
 */
function SendingLine({
  provider,
  state,
  busy,
  onChange,
}: {
  provider: DigitalMailboxProviderId
  state: DigitalMailboxSending
  busy: boolean
  onChange: (on: boolean) => void
}) {
  const t = useTranslations('inkorg')
  const id = useId()
  const name = t(`mailbox_${provider}_name`)
  const note =
    state === 'pending' ? t('digital_sending_pending', { provider: name })
    : state === 'rejected' ? t('digital_sending_rejected', { provider: name })
    : null
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-xs text-muted-foreground">
          {t('digital_sending')}
        </label>
        <Switch
          id={id}
          checked={state === 'active' || state === 'pending'}
          disabled={busy}
          onCheckedChange={onChange}
          aria-label={t('digital_sending_aria', { provider: name })}
        />
      </div>
      {note && (state === 'rejected' ? <AttnLine>{note}</AttnLine> : <p className="text-xs text-muted-foreground">{note}</p>)}
    </div>
  )
}

function DigitalRowMenu({ provider, onDisconnect }: { provider: DigitalMailboxProviderId; onDisconnect: () => void }) {
  const t = useTranslations('inkorg')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={t('digital_more', { provider: t(`mailbox_${provider}_name`) })}>
          <EllipsisHorizontalIcon className="h-[15px] w-[15px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onDisconnect}>{t('digital_disconnect')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Kivra: the company activates Accounted at Kivra (the onboarding page opens
 * in a new tab); the row waits until Kivra confirms, by its webhook, the
 * cron's lookup or "Kontrollera", and then reads the mailbox.
 */
export function KivraRow({ slot, onConnection, reload, Row = DialogDigitalRow, connectVariant }: DigitalRowProps) {
  const actions = useDigitalMailboxActions('kivra', { onConnection, reload })
  const { t, busy } = actions
  // Kivra's activation page from the last connect answer, reopened without another round trip.
  const [onboardingUrl, setOnboardingUrl] = useState<string | null>(null)

  if (slot.status !== 'ready') return <DigitalPlaceholderRow door="kivra" status={slot.status} Row={Row} />
  const view = digitalMailboxRowView(slot.answer.available, slot.answer.connection)
  const status = <DigitalStatus provider="kivra" view={view} />
  const notes = hasDigitalNotes(view) ? <DigitalNotes provider="kivra" view={view} /> : undefined

  async function connect() {
    // Opened on the click itself, so the browser allows it, and pointed at
    // Kivra once the answer is in. No 'noopener' feature: with it
    // window.open returns null; the opener link is cut by hand.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    actions.setBusy('connect')
    const answer = await mailboxRequest<{ connection: ConnectionSummary; onboarding_url: string | null }>(
      'kivra/receive',
      'POST',
      actions.locale,
    )
    actions.setBusy(null)
    if (!answer.ok) {
      tab?.close()
      actions.toast({ title: t('digital_connect_failed', { provider: actions.name }), description: answer.message, variant: 'destructive' })
      return
    }
    onConnection(answer.data.connection)
    const url = httpsUrl(answer.data.onboarding_url)
    setOnboardingUrl(url)
    // Already active at Kivra: nothing to open. A blocked tab leaves the row
    // waiting with "Öppna Kivra", which opens the page from a click of its own.
    if (url && tab) tab.location.href = url
    else tab?.close()
  }

  function openKivra() {
    if (onboardingUrl) window.open(onboardingUrl, '_blank', 'noopener,noreferrer')
    else void connect()
  }

  const sending = view.sending ? (
    <SendingLine
      provider="kivra"
      state={view.sending}
      busy={busy === 'sending'}
      onChange={(on) => void actions.setSending(on)}
    />
  ) : undefined

  if (view.receive === 'off') {
    return (
      <Row door="kivra" extra={sending}>
        <Button variant={connectVariant} loading={busy === 'connect'} onClick={() => void connect()}>
          {t('connect_kivra')}
        </Button>
      </Row>
    )
  }
  if (view.receive === 'pending') {
    return (
      <Row door="kivra" status={status} notes={notes} extra={sending}>
        <Button variant="outline" loading={busy === 'connect'} onClick={openKivra}>
          {t('kivra_open')}
        </Button>
        <Button variant="outline" loading={busy === 'sync'} onClick={() => void actions.sync(true)}>
          {t('kivra_check')}
        </Button>
      </Row>
    )
  }
  return (
    <Row door="kivra" status={status} connected notes={notes} extra={sending}>
      <Button variant="outline" loading={busy === 'sync'} onClick={() => void actions.sync(false)}>
        {t('digital_fetch_now')}
      </Button>
      <DigitalRowMenu provider="kivra" onDisconnect={() => void actions.disconnect()} />
      <DestructiveConfirmDialog {...actions.dialogProps} />
    </Row>
  )
}

/**
 * Billo: the company's business mailbox is created from here, with the
 * admin (BankID) as its representative, and read from then on.
 */
export function BilloRow({ slot, onConnection, reload, Row = DialogDigitalRow, connectVariant }: DigitalRowProps) {
  const actions = useDigitalMailboxActions('billo', { onConnection, reload })
  const { t, busy } = actions
  const [creating, setCreating] = useState(false)

  if (slot.status !== 'ready') return <DigitalPlaceholderRow door="billo" status={slot.status} Row={Row} />
  const view = digitalMailboxRowView(slot.answer.available, slot.answer.connection)

  const sending = view.sending ? (
    <SendingLine
      provider="billo"
      state={view.sending}
      busy={busy === 'sending'}
      onChange={(on) => void actions.setSending(on)}
    />
  ) : undefined

  if (view.receive === 'off') {
    return (
      <Row door="billo" extra={sending}>
        <Button variant={connectVariant} onClick={() => setCreating(true)}>
          {t('billo_create')}
        </Button>
        <BilloCreateDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(connection) => {
            setCreating(false)
            onConnection(connection)
            actions.toast({ title: t('billo_created') })
          }}
        />
      </Row>
    )
  }
  return (
    <Row
      door="billo"
      status={<DigitalStatus provider="billo" view={view} />}
      connected={view.receive === 'active'}
      notes={hasDigitalNotes(view) ? <DigitalNotes provider="billo" view={view} /> : undefined}
      extra={sending}
    >
      {view.receive === 'active' && (
        <Button variant="outline" loading={busy === 'sync'} onClick={() => void actions.sync(false)}>
          {t('digital_fetch_now')}
        </Button>
      )}
      <DigitalRowMenu provider="billo" onDisconnect={() => void actions.disconnect()} />
      <DestructiveConfirmDialog {...actions.dialogProps} />
    </Row>
  )
}

function BilloCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (connection: ConnectionSummary) => void
}) {
  const t = useTranslations('inkorg')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{t('billo_dialog_title')}</DialogTitle>
          <DialogDescription>{t('billo_dialog_intro')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: each open reads what Billo would get anew. */}
        <BilloCreateForm onCancel={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  )
}

/** GET /api/digital-mailboxes/billo/representative. */
interface BilloPreview {
  representative: { name: string | null; has_bankid: boolean; email: string | null }
  company: {
    name: string
    org_number: string | null
    address_line1: string | null
    postal_code: string | null
    city: string | null
  } | null
}

type BilloPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: BilloPreview }
  /** message: the server's refusal (a member who is not an admin), null when the read never got an answer. */
  | { status: 'failed'; message: string | null }

/** The shape check only; the route validates the address itself. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function BilloCreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (connection: ConnectionSummary) => void }) {
  const t = useTranslations('inkorg')
  const tCommon = useTranslations('common')
  const locale: ErrorLocale = useLocale() === 'en' ? 'en' : 'sv'
  const emailId = useId()
  const phoneId = useId()
  const [state, setState] = useState<BilloPreviewState>({ status: 'loading' })
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [invalid, setInvalid] = useState({ email: false, phone: false })
  const [submitting, setSubmitting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/digital-mailboxes/billo/representative')
        if (!res.ok) {
          const message = await getResponseErrorMessage(res, undefined, locale)
          if (!cancelled) setState({ status: 'failed', message })
          return
        }
        const json = (await res.json()) as { data?: BilloPreview }
        if (cancelled) return
        const preview = json.data
        if (!preview) {
          setState({ status: 'failed', message: null })
          return
        }
        setState({ status: 'ready', preview })
        setEmail((current) => current || preview.representative.email || '')
      } catch {
        if (!cancelled) setState({ status: 'failed', message: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [locale])

  const preview = state.status === 'ready' ? state.preview : null
  const company = preview?.company ?? null
  const companyComplete = !!company?.org_number && !!company.address_line1 && !!company.postal_code && !!company.city
  const canSubmit = !!preview && companyComplete && preview.representative.has_bankid
  const address = company
    ? [company.address_line1, [company.postal_code, company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null
    : null
  const representative = preview ? (preview.representative.name ?? (preview.representative.has_bankid ? t('billo_you') : null)) : null

  // One attention line: what keeps the mailbox from being created, else what Billo or the route refused.
  const attention =
    state.status === 'failed' ? (
      <AttnLine>{state.message ?? t('billo_load_failed')}</AttnLine>
    ) : preview && !companyComplete ? (
      <AttnLine action={{ label: t('billo_open_settings'), href: '/settings/company' }}>{t('billo_needs_company')}</AttnLine>
    ) : preview && !preview.representative.has_bankid ? (
      <AttnLine>{t('billo_needs_bankid')}</AttnLine>
    ) : problem ? (
      <AttnLine>{problem}</AttnLine>
    ) : null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit || submitting) return
    const next = { email: !EMAIL_SHAPE.test(email.trim()), phone: phoneToE164(phone) === null }
    setInvalid(next)
    if (next.email || next.phone) return
    setSubmitting(true)
    setProblem(null)
    // The personnummer is never sent: the route reads it from the admin's BankID login.
    const answer = await mailboxRequest<{ connection: ConnectionSummary }>('billo/receive', 'POST', locale, {
      email: email.trim(),
      phone: phone.trim(),
    })
    setSubmitting(false)
    if (!answer.ok) {
      setProblem(answer.message)
      return
    }
    onCreated(answer.data.connection)
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-6">
      {state.status === 'loading' ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-56 rounded-sm" />
          <Skeleton className="h-4 w-40 rounded-sm" />
          <Skeleton className="h-4 w-48 rounded-sm" />
          <Skeleton className="h-4 w-32 rounded-sm" />
        </div>
      ) : preview ? (
        <dl data-ph-mask="" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
          <BilloFact label={t('billo_field_company')} value={company?.name || null} />
          <BilloFact
            label={t('billo_field_org_number')}
            value={company?.org_number ? formatOrgNumberDisplay(company.org_number) : null}
          />
          <BilloFact label={t('billo_field_address')} value={address} />
          <BilloFact label={t('billo_field_representative')} value={representative} />
        </dl>
      ) : null}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={emailId}>{t('billo_field_email')}</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={invalid.email || undefined}
            aria-describedby={invalid.email ? `${emailId}-hint` : undefined}
          />
          {invalid.email && (
            <p id={`${emailId}-hint`} className="text-xs text-destructive">
              {t('billo_email_invalid')}
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={phoneId}>{t('billo_field_phone')}</Label>
          <Input
            id={phoneId}
            type="tel"
            autoComplete="tel"
            placeholder={t('billo_phone_placeholder')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={invalid.phone || undefined}
            aria-describedby={invalid.phone ? `${phoneId}-hint` : undefined}
          />
          {invalid.phone && (
            <p id={`${phoneId}-hint`} className="text-xs text-destructive">
              {t('billo_phone_invalid')}
            </p>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('billo_consent')}{' '}
        <a
          href="https://billo.life/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          {t('billo_terms')}
        </a>
      </p>

      {attention}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" loading={submitting} disabled={!canSubmit}>
          {t('billo_create')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function BilloFact({ label, value }: { label: string; value: string | null }) {
  const t = useTranslations('inkorg')
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={value ? 'min-w-0 break-words' : 'text-muted-foreground'}>{value ?? t('billo_missing')}</dd>
    </>
  )
}
