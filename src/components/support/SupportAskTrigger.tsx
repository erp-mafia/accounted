'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useFabHidden } from '@/components/agent/use-fab-hidden'
import { QuestionMarkCircleIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { AGENT_FAB_PROPS } from '@/components/ui/fab-clearance'
import { SupportLink } from '@/components/ui/support-link'

/**
 * The floating button for a person whose built-in assistant is gone
 * (ASSISTANT_CHAT_ENABLED, lib/env/assistant-chat-switch.ts) and who had its
 * button: the same corner now opens the AI assistant in the support dialog,
 * so the place they asked their questions still answers them.
 *
 * It is drawn as another thing than the button it follows (AgentTrigger: the
 * dark pill with the assistant's own name and face): a light bar, a question
 * mark and the word support. What it opens reads and explains and does
 * nothing in the books, and it should not look like the assistant that did.
 *
 * Desktop only, like the button it follows, and hidden by the same
 * preference: the X hides it for good, with an undo. Not on /chat, where the
 * page itself offers the question, nor on the verifikation editor, which is
 * kept clear of floating buttons.
 */
export function SupportAskTrigger({ hidden = false }: { hidden?: boolean }) {
  const t = useTranslations('support_link')
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const { effectiveHidden, hideFab } = useFabHidden(hidden, {
    title: t('ask_fab_hidden_title'),
    description: t('ask_fab_hidden_description'),
  })

  const segments = pathname?.split('/').filter(Boolean) ?? []
  const onEditor = segments[0] === 'bookkeeping' && Boolean(segments[1]) && segments[1] !== 'year-end' && segments[1] !== 'new'
  const shown = !effectiveHidden && !open && !pathname?.startsWith('/chat') && !onEditor

  return (
    <>
      {shown && (
        <div
          {...AGENT_FAB_PROPS}
          className="fixed bottom-4 right-4 z-[45] hidden items-center gap-0.5 rounded-pop bg-popover p-1 shadow-float md:flex md:[body:has([data-page-bottom-bar])_&]:bottom-20"
        >
          <Button type="button" variant="ghost" size="toolbar" onClick={() => setOpen(true)}>
            <QuestionMarkCircleIcon className="h-4 w-4" />
            {t('ask_fab')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-toolbar"
            className="text-muted-foreground"
            aria-label={t('ask_fab_hide')}
            title={t('ask_fab_hide')}
            onClick={() => void hideFab()}
          >
            <XMarkIcon className="h-4 w-4" />
          </Button>
        </div>
      )}
      <SupportLink variant="hidden" open={open} onOpenChange={setOpen} />
    </>
  )
}
