'use client'

import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useFabHidden } from '@/components/agent/use-fab-hidden'
import { QuestionMarkCircleIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { AGENT_FAB_PROPS } from '@/components/ui/fab-clearance'

/**
 * The floating button that opens the support panel (SupportDock.tsx), for
 * everyone in a company without the built-in assistant
 * (ASSISTANT_CHAT_ENABLED, lib/env/assistant-chat-switch.ts): the corner
 * where that assistant's button sat is where a question is asked now.
 *
 * It is drawn as another thing than the button it follows (AgentTrigger: the
 * dark pill with the assistant's own name and face): a light bar, a question
 * mark and the word support. What it opens reads and explains and does
 * nothing in the books, and it should not look like the assistant that did.
 *
 * Desktop only, like the button it follows. Its own choice to hide: a person
 * who hid the assistant's button said nothing about this one. The X hides
 * it, with an undo, and Inställningar > Ditt konto brings it back
 * (components/settings/FabVisibilityRow.tsx). Not while the panel is
 * open (the panel sits where the button is), not on /chat, where the page
 * itself offers the question, nor on the verifikation editor, which is kept
 * clear of floating buttons.
 */
export function SupportAskTrigger({
  hidden = false,
  open,
  onOpen,
}: {
  hidden?: boolean
  /** The panel is open. */
  open: boolean
  onOpen: () => void
}) {
  const t = useTranslations('support_link')
  const pathname = usePathname()
  const { effectiveHidden, hideFab } = useFabHidden(
    hidden,
    { title: t('ask_fab_hidden_title'), description: t('ask_fab_hidden_description') },
    'support',
  )

  const segments = pathname?.split('/').filter(Boolean) ?? []
  const onEditor = segments[0] === 'bookkeeping' && Boolean(segments[1]) && segments[1] !== 'year-end' && segments[1] !== 'new'
  if (effectiveHidden || open || pathname?.startsWith('/chat') || onEditor) return null

  return (
    <div
      {...AGENT_FAB_PROPS}
      className="fixed bottom-4 right-4 z-[45] hidden items-center gap-0.5 rounded-pop bg-popover p-1 shadow-float md:flex md:[body:has([data-page-bottom-bar])_&]:bottom-20"
    >
      <Button type="button" variant="ghost" size="toolbar" onClick={onOpen}>
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
  )
}
