'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { GoogleMark } from '@/components/ui/provider-marks'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useFormat } from '@/lib/hooks/use-format'
import { cn } from '@/lib/utils'
import { ReceiptHuntStatus } from './ReceiptHuntStatus'
import {
  disconnectMailbox,
  reconnectReason,
  requestMailConnect,
  summarizeMailboxes,
  type MailCallbackCode,
  type MailConnection,
} from './mail-connections'
import { useMailConnections } from './use-mail-connections'
import { useReceiptHunt } from './use-receipt-hunt'

/**
 * Kopplingar > Gmail: connect, reconnect and disconnect the company's
 * mailboxes, run the receipt hunt, and say plainly what the access allows.
 *
 * Everything the page claims is what the backend does: the grant is
 * gmail.readonly and nothing else, only mails that may be the receipt for a
 * specific purchase without an underlag are read, a receipt that is found is
 * filed in Underlag with its sender, subject and date, and disconnecting
 * revokes the grant at Google as well as deleting it here. A new claim on
 * this page needs the code behind it first.
 */
export function MailConnectionsPanel({
  notice,
}: {
  /** How the OAuth callback came back when it did not connect anything. */
  notice: Exclude<MailCallbackCode, 'connected'> | null
}) {
  const t = useTranslations('mail')
  const { toast } = useToast()
  const { formatDateLong } = useFormat()
  const hasAi = useCapability(CAPABILITY.ai)
  const { dialogProps, confirm } = useDestructiveConfirm()
  // A build without the mail extension has no route to ask.
  const mailExtension = ENABLED_EXTENSION_IDS.has('mail')
  const mail = useMailConnections(mailExtension)
  const [connecting, setConnecting] = useState(false)

  // Back from Google's consent screen without finishing: a page restored
  // from the back-forward cache still holds the busy connect button.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setConnecting(false)
    }
    window.addEventListener('pageshow', reset)
    return () => window.removeEventListener('pageshow', reset)
  }, [])
  // A pass moves lastSearchedAt, so the list is read again after each one.
  const hunt = useReceiptHunt(() => void mail.reload())

  const view = mail.view
  const summary = summarizeMailboxes(view)
  const connections = view?.connections ?? []

  async function connect() {
    setConnecting(true)
    const start = await requestMailConnect()
    if (start.ok) {
      // Same tab: Google's consent screen sends the browser back here, to
      // /settings/mail?mail=<code>. The button stays busy until it leaves.
      window.location.assign(start.url)
      return
    }
    setConnecting(false)
    toast({
      title:
        start.reason === 'connect_disabled'
          ? t('connect_closed')
          : start.reason === 'not_configured'
            ? t('not_configured')
            : t('connect_failed'),
      variant: 'destructive',
    })
    // The route knows better than the page did: show what it says now.
    if (start.reason !== 'failed') void mail.reload()
  }

  async function disconnect(connection: MailConnection) {
    await confirm(
      {
        title: t('disconnect_title', { address: connection.emailAddress }),
        description: t('disconnect_body'),
        confirmLabel: t('disconnect'),
      },
      async () => {
        const result = await disconnectMailbox(connection.id)
        if (!result.ok) {
          toast({
            title: t(result.reason === 'not_allowed' ? 'disconnect_not_allowed' : 'disconnect_failed'),
            variant: 'destructive',
          })
          throw new Error('disconnect failed')
        }
        toast({ title: t('disconnected_toast', { address: connection.emailAddress }) })
        await mail.reload()
      },
    )
  }

  function statusText(connection: MailConnection): string {
    switch (reconnectReason(connection)) {
      case 'scope_missing':
        return t('needs_reconnect_scope')
      case 'access_ended':
        return t('needs_reconnect_ended')
      case 'other':
        return t('needs_reconnect')
      default:
        return connection.lastSearchedAt
          ? t('last_searched', { date: formatDateLong(connection.lastSearchedAt) })
          : t('never_searched')
    }
  }

  const connectButton = (label: string, ariaLabel?: string) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={connecting}
      onClick={() => void connect()}
      aria-label={ariaLabel}
    >
      {!connecting && <GoogleMark className="mr-2 h-3.5 w-3.5" />}
      {label}
    </Button>
  )

  const noticeText = notice
    ? {
        denied: t('callback_denied'),
        invalid: t('callback_invalid'),
        expired: t('callback_expired'),
        mismatch: t('callback_mismatch'),
        no_refresh_token: t('callback_no_refresh_token'),
        no_address: t('callback_no_address'),
        failed: t('callback_failed'),
        scope_missing: t('callback_scope_missing'),
      }[notice]
    : null

  return (
    <>
      {noticeText ? (
        // One sentence, until the next attempt replaces it: the callback
        // parameter is already gone from the URL.
        <div role="alert" className="px-1 pt-6">
          <AttnLine
            action={
              summary.canConnect
                ? { label: notice === 'denied' ? t('connect') : t('reconnect'), onClick: () => void connect() }
                : undefined
            }
          >
            {noticeText}
          </AttnLine>
        </div>
      ) : null}

      <SettingsGroup label={t('group_mailboxes')} help={t('group_mailboxes_help')}>
        {!mailExtension ? (
          <SettingsRow label={t('none_label')} borderless>
            <SettingsRowNote>{t('not_configured')}</SettingsRowNote>
          </SettingsRow>
        ) : mail.loading ? (
          <div aria-busy="true" className="flex items-center justify-between gap-8 py-6">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-8 w-28 rounded-full" />
          </div>
        ) : !view ? (
          <div className="px-1 pt-3">
            <AttnLine action={{ label: t('retry'), onClick: () => void mail.reload() }}>{t('load_failed')}</AttnLine>
          </div>
        ) : connections.length === 0 ? (
          <SettingsRow label={t('none_label')} borderless>
            {summary.canConnect ? (
              <SettingsRowEnd>{connectButton(t('connect'))}</SettingsRowEnd>
            ) : (
              <SettingsRowNote>{view.configured ? t('connect_closed') : t('not_configured')}</SettingsRowNote>
            )}
          </SettingsRow>
        ) : (
          <>
            {connections.map((connection, index) => {
              const reason = reconnectReason(connection)
              return (
                <SettingsRow
                  key={connection.id}
                  borderless={!summary.canConnect && index === connections.length - 1}
                  label={
                    <span className="flex min-w-0 items-center gap-2">
                      <GoogleMark className="h-3.5 w-3.5 shrink-0" />
                      <span data-ph-mask="" className="truncate">
                        {connection.emailAddress}
                      </span>
                    </span>
                  }
                >
                  <SettingsRowNote className={cn('min-w-0', reason && 'text-attn')}>
                    {statusText(connection)}
                  </SettingsRowNote>
                  <SettingsRowEnd>
                    {reason && summary.canConnect
                      ? connectButton(t('reconnect'), t('reconnect_aria', { address: connection.emailAddress }))
                      : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void disconnect(connection)}
                      aria-label={t('disconnect_aria', { address: connection.emailAddress })}
                    >
                      {t('disconnect')}
                    </Button>
                  </SettingsRowEnd>
                </SettingsRow>
              )
            })}
            {summary.canConnect ? (
              <SettingsRow label={t('connect_another')} borderless>
                <SettingsRowEnd>{connectButton(t('connect'))}</SettingsRowEnd>
              </SettingsRow>
            ) : null}
          </>
        )}
      </SettingsGroup>

      {summary.active.length > 0 ? (
        <SettingsGroup label={t('hunt_group')} help={t('hunt_help')}>
          <SettingsRow label={t('hunt_row')} borderless>
            <ReceiptHuntStatus
              hunt={hunt}
              blocked={!hasAi}
              className="min-w-0 text-[12.5px] text-muted-foreground"
            />
            <SettingsRowEnd>
              {hunt.hunting && !hunt.stopping ? (
                <Button type="button" variant="ghost" size="sm" onClick={hunt.stop}>
                  {t('hunt_stop')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={hunt.hunting}
                disabled={!hasAi}
                onClick={() => void hunt.hunt()}
              >
                {hunt.hunting ? t('hunt_running') : t('hunt_action')}
              </Button>
            </SettingsRowEnd>
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {/* What the grant allows, stated before and after connecting: the
          consent screen itself only says "read your email". */}
      <SettingsGroup label={t('access_group')}>
        <SettingsRow label={t('access_read_label')}>
          <SettingsRowNote>{t('access_read')}</SettingsRowNote>
        </SettingsRow>
        <SettingsRow label={t('access_scope_label')}>
          <SettingsRowNote>{t('access_scope')}</SettingsRowNote>
        </SettingsRow>
        <SettingsRow label={t('access_kept_label')}>
          <SettingsRowNote>{t('access_kept')}</SettingsRowNote>
        </SettingsRow>
        <SettingsRow label={t('access_revoke_label')} borderless>
          <SettingsRowNote>{t('access_revoke')}</SettingsRowNote>
        </SettingsRow>
      </SettingsGroup>

      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}
