'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ATTN_ACTION_CLASS, AttnLine } from '@/components/ui/attn-line'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useFormat } from '@/lib/hooks/use-format'

/**
 * One line at the top of the built-in chat, over the empty state and over a
 * conversation alike: the chat will be removed, the bookkeeping is done with
 * a person's own assistant (Claude, for one), connected under Agenter >
 * Koppla en agent, and questions about the app go to support. It tells people
 * before the chat is switched off (ASSISTANT_CHAT_ENABLED). It names the day
 * only where one is set (ASSISTANT_CHAT_UNTIL, for the companies that keep
 * the chat after it is switched off), and otherwise stays true for as long
 * as the chat is there.
 *
 * It sits above the thread, outside the scroller, so the composer stays
 * where it is. The link is the menu's own two labels, so a renamed row
 * cannot leave the sentence pointing at a name that is gone; an installation
 * without the MCP server extension has no Koppla en agent and gets the first
 * sentence alone.
 *
 * On every conversation, whatever its intent.
 */
export function ChatRemovalNotice() {
  const t = useTranslations('agent_chat')
  const tNav = useTranslations('nav')

  const { formatDateLong } = useFormat()
  const until = useCompanyOptional()?.assistantChatUntil ?? null
  const canConnect = ENABLED_EXTENSION_IDS.has('mcp-server')
  const date = until ? formatDateLong(until) : ''
  return (
    <AttnLine tone="info" className="shrink-0 border-b-hairline px-5 py-2.5">
      {canConnect
        ? t.rich(until ? 'removal_notice_connect_until' : 'removal_notice_connect', {
            date,
            place: `${tNav('v3_agents')} > ${tNav('v3_connect_agent')}`,
            link: (chunks) => (
              <Link href="/settings/api" className={ATTN_ACTION_CLASS}>
                {chunks}
              </Link>
            ),
          })
        : until
          ? t('removal_notice_until', { date })
          : t('removal_notice')}
    </AttnLine>
  )
}
