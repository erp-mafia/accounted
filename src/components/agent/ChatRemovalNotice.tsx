'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ATTN_ACTION_CLASS, AttnLine } from '@/components/ui/attn-line'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

/**
 * One line at the top of the built-in chat, over the empty state and over a
 * conversation alike: the chat will be removed, the bookkeeping is done with
 * a person's own assistant (Claude, for one), connected under Agenter >
 * Koppla en agent, and questions about the app go to support (founder
 * decisions 2026-11-17 and 2026-11-18, docs/decisions). It tells people
 * before the chat is switched off (ASSISTANT_CHAT_ENABLED), so it names no
 * day and stays true for as long as the chat is there.
 *
 * It sits above the thread, outside the scroller, so the composer stays
 * where it is. The link is the menu's own two labels, so a renamed row
 * cannot leave the sentence pointing at a name that is gone; an installation
 * without the MCP server extension has no Koppla en agent and gets the first
 * sentence alone.
 *
 * On every conversation, the interview a newly built assistant holds with
 * the company included: that goes with the chat.
 */
export function ChatRemovalNotice() {
  const t = useTranslations('agent_chat')
  const tNav = useTranslations('nav')

  const canConnect = ENABLED_EXTENSION_IDS.has('mcp-server')
  return (
    <AttnLine tone="info" className="shrink-0 border-b-hairline px-5 py-2.5">
      {canConnect
        ? t.rich('removal_notice_connect', {
            place: `${tNav('v3_agents')} > ${tNav('v3_connect_agent')}`,
            link: (chunks) => (
              <Link href="/settings/api" className={ATTN_ACTION_CLASS}>
                {chunks}
              </Link>
            ),
          })
        : t('removal_notice')}
    </AttnLine>
  )
}
