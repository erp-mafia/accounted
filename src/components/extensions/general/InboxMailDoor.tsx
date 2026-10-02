'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GoogleMark } from '@/components/ui/provider-marks'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useFormat } from '@/lib/hooks/use-format'
import { cn } from '@/lib/utils'
import { ReceiptHuntStatus } from './ReceiptHuntStatus'
import { MAIL_SETTINGS_HREF, summarizeMailboxes, type MailConnectionsView } from './mail-connections'
import type { ReceiptHunt } from './use-receipt-hunt'

/**
 * Gmail as a door in the Underlag sources panel: which mailboxes the hunt
 * reads, when each was last searched, and the button that searches them.
 *
 * Nothing here is configuration (the panel's rule): connecting, reconnecting
 * and disconnecting live in Inställningar > Kopplingar > Gmail, and a
 * mailbox that needs a new consent links there. What a run finds needs no
 * UI of its own: it lands as an ordinary inbox item in the list below.
 */
export function InboxMailDoor({
  view,
  hunt,
  hasAi,
}: {
  view: MailConnectionsView
  /** Owned by the workspace, so a run survives the panel being closed. */
  hunt: ReceiptHunt
  /** The hunt reads PDFs with AI: without the paid capability it is refused. */
  hasAi: boolean
}) {
  const t = useTranslations('inbox_workspace')
  const tMail = useTranslations('mail')
  const { formatDateLong } = useFormat()
  const { active } = summarizeMailboxes(view)
  const connections = view.connections

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-3 px-4 py-2">
        <GoogleMark className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate">Gmail</span>
        {connections.length === 0 ? (
          <span className="shrink-0 text-muted-foreground">{t('source_gmail_not_connected')}</span>
        ) : (
          <>
            {hunt.hunting && !hunt.stopping ? (
              <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={hunt.stop}>
                {tMail('hunt_stop')}
              </Button>
            ) : null}
            {/* A run needs a mailbox it can read: one waiting for a new
                consent would make every pass report nothing. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              loading={hunt.hunting}
              disabled={active.length === 0 || !hasAi}
              onClick={() => void hunt.hunt()}
            >
              {!hunt.hunting && <Search className="mr-1.5 h-3.5 w-3.5" />}
              {hunt.hunting ? tMail('hunt_running') : t('hunt_button')}
            </Button>
          </>
        )}
      </div>
      <div className="space-y-1.5 px-4 pb-2.5 pl-11 text-[11px] text-muted-foreground">
        {connections.length > 0 ? (
          <ul className="space-y-0.5">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-wrap items-baseline gap-x-2">
                <span data-ph-mask="" className="min-w-0 truncate text-foreground">
                  {connection.emailAddress}
                </span>
                {connection.status === 'active' ? (
                  <span>
                    {connection.lastSearchedAt
                      ? tMail('last_searched', { date: formatDateLong(connection.lastSearchedAt) })
                      : tMail('never_searched')}
                  </span>
                ) : (
                  <Link
                    href={MAIL_SETTINGS_HREF}
                    className="text-attn underline underline-offset-2 hover:opacity-80"
                  >
                    {t('source_gmail_needs_reconnect')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {connections.length > 0 ? <ReceiptHuntStatus hunt={hunt} blocked={!hasAi} /> : null}
        <Link href={MAIL_SETTINGS_HREF} className={cn(QUIET_LINK_CLASS, 'block text-[11px]')}>
          {connections.length > 0 ? t('source_gmail_manage') : t('source_gmail_connect')}
        </Link>
      </div>
    </div>
  )
}
