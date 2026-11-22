'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowUturnLeftIcon, ChatBubbleLeftIcon, LinkIcon, type Icon as AppIcon } from '@/components/icons'
import { PADDED_CANVAS_CLASS } from '@/components/dashboard/MainContainer'
import { StartCard } from '@/components/dashboard/StartCard'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { SupportLink } from '@/components/ui/support-link'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useFormat } from '@/lib/hooks/use-format'
import { openSupportDock } from '@/lib/support/dock'

/** Agenter > Koppla en agent: where a person's own AI is connected. */
const CONNECT_HREF = '/settings/api'

function Way({
  icon: Icon,
  title,
  body,
  children,
}: {
  icon: AppIcon
  title: string
  body: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col items-start gap-2">
      <Icon aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
      <h2 className="text-[15px] font-medium leading-[22px] text-strong">{title}</h2>
      <p className="text-pretty text-sm text-foreground/80">{body}</p>
      <div className="mt-1">{children}</div>
    </section>
  )
}

/**
 * /chat for a company without the built-in chat (ASSISTANT_CHAT_ENABLED,
 * lib/env/assistant-chat-switch.ts): what took its place, said once where a
 * person goes looking for the chat: the Chatt row stays in the menu until
 * the chat is gone for everyone, and for a company without the chat it leads
 * here, as its other pages and the addresses of the removed build and
 * interview do.
 *
 * Two ways forward and one way back: questions go to the AI assistant in the
 * support dialog, the bookkeeping to a person's own AI connected under
 * Agenter > Koppla en agent, and a company that wants the chat a while longer
 * writes to support. `until` is the last day anyone has it
 * (ASSISTANT_CHAT_UNTIL); the day is named only when one is set.
 *
 * A way that is not there is not offered: the assistant where the company
 * does not have it (the support form takes the question instead), the
 * connection in an installation without the MCP server extension.
 */
export function ChatReplaced({ until }: { until: string | null }) {
  const t = useTranslations('agent_chat')
  const tNav = useTranslations('nav')
  const { formatDateLong } = useFormat()
  const company = useCompanyOptional()
  // Which support dialog is open: on the assistant, or on the form to a person.
  const [support, setSupport] = useState<'ask' | 'keep' | null>(null)

  const hasAssistant = company?.supportAssistant === true
  const canConnect = ENABLED_EXTENSION_IDS.has('mcp-server')
  // The assistant answers in the docked panel where the page has one
  // (lib/support/dock.ts); on a phone, and for the form, the dialog below.
  const ask = () => {
    if (hasAssistant && openSupportDock()) return
    setSupport('ask')
  }

  return (
    <div className={PADDED_CANVAS_CLASS}>
      <div className="space-y-8">
        <PageHeader title={tNav('v3_chat')} />

        <div className="animate-fade-in">
          <StartCard
            card="geese"
            layout="side-right"
            title={t('replaced_title')}
            body={t(canConnect ? 'replaced_body' : 'replaced_body_ask_only')}
            primary={{ label: t(hasAssistant ? 'replaced_ask_action' : 'replaced_keep_action'), onClick: ask }}
            secondary={canConnect ? { label: t('replaced_do_action'), href: CONNECT_HREF } : undefined}
          />
        </div>

        <div className="grid gap-8 md:grid-cols-3">
          <Way
            icon={ChatBubbleLeftIcon}
            title={t('replaced_ask_title')}
            body={t(hasAssistant ? 'replaced_ask_body' : 'replaced_ask_body_staff')}
          >
            <Button type="button" variant="outline" onClick={ask}>
              {t(hasAssistant ? 'replaced_ask_action' : 'replaced_keep_action')}
            </Button>
          </Way>

          {canConnect && (
            <Way icon={LinkIcon} title={t('replaced_do_title')} body={t('replaced_do_body')}>
              <Button asChild variant="outline">
                <Link href={CONNECT_HREF}>{t('replaced_do_action')}</Link>
              </Button>
            </Way>
          )}

          <Way
            icon={ArrowUturnLeftIcon}
            title={t('replaced_keep_title')}
            body={
              until
                ? t('replaced_keep_body_until', { date: formatDateLong(until) })
                : t('replaced_keep_body')
            }
          >
            <Button type="button" variant="outline" onClick={() => setSupport('keep')}>
              {t('replaced_keep_action')}
            </Button>
          </Way>
        </div>
      </div>

      <SupportLink variant="hidden" open={support === 'ask'} onOpenChange={(open) => setSupport(open ? 'ask' : null)} />
      {/* Asking for the chat back is a matter for a person, never the assistant. */}
      <SupportLink
        variant="hidden"
        subject={t('replaced_keep_subject')}
        assistant={false}
        open={support === 'keep'}
        onOpenChange={(open) => setSupport(open ? 'keep' : null)}
      />
    </div>
  )
}
