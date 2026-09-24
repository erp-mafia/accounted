'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AI_CLIENTS,
  aiPrefilledChatLink,
  kvittojaktenSkillSlug,
  openAiConnector,
  pickConnectedAiClient,
  type AiClient,
} from '@/lib/onboarding/ai-clients'

/**
 * Kvittojakten needs two connections, and Accounted can only see one of them.
 * The button renders on an MCP OAuth key, which proves Accounted reached the
 * client; whether a *mailbox* is connected inside that client is invisible
 * from here. Saying so once, before the first run, is convention 10 (confirm
 * up front) rather than letting the user find out from an empty report.
 */
const PREREQ_KEY = 'accounted.kvittojakten.prereq'

function prereqSeen(): boolean {
  try {
    return window.localStorage.getItem(PREREQ_KEY) === 'seen'
  } catch {
    return false
  }
}

function markPrereqSeen(): void {
  try {
    window.localStorage.setItem(PREREQ_KEY, 'seen')
  } catch {
    // Private windows and blocked site data: showing the card once more is
    // the whole consequence, so there is nothing to recover from.
  }
}

const pillClass =
  'inline-flex h-6 shrink-0 items-center gap-2 rounded-full bg-primary px-3 text-[11px] text-primary-foreground transition-colors duration-150 hover:bg-primary/85 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * "Kvittojakten": one click opens the connected AI client with the prompt
 * already typed in. The agent then loads the skill written for that client
 * (kvittojakten-claude, -chatgpt, -grok), searches the user's own mailbox for
 * the underlag that are missing and stages the links for approval.
 *
 * Unlike AiTaskAction there is no review dialog and no clipboard step: the
 * prompt names a skill and nothing else, so it may travel in the chat URL
 * (see aiPrefilledChatLink). Renders nothing while no client is connected.
 *
 * `pill` sits on an Att göra row; `button` sits in a page header.
 */
export function KvittojaktenButton({
  clients,
  preferredClient,
  variant = 'pill',
  onOpen,
  disabled = false,
}: {
  clients: AiClient[]
  preferredClient?: AiClient
  variant?: 'pill' | 'button'
  onOpen?: () => void
  disabled?: boolean
}) {
  const t = useTranslations('dashboard')
  const [pending, setPending] = useState<AiClient | null>(null)

  const connected = AI_CLIENTS.filter((c) => clients.includes(c.id))
  if (connected.length === 0) return null

  const primaryId = pickConnectedAiClient(clients, preferredClient)
  const primary = connected.find((client) => client.id === primaryId)!
  const others = connected.filter((client) => client.id !== primaryId)
  const pendingClient = connected.find((client) => client.id === pending)

  function open(client: AiClient) {
    if (disabled) return
    if (prereqSeen()) {
      run(client)
      return
    }
    setPending(client)
  }

  function run(client: AiClient) {
    markPrereqSeen()
    setPending(null)
    const prompt = t('ai_kvittojakten_prompt', { skill: kvittojaktenSkillSlug(client) })
    openAiConnector(aiPrefilledChatLink(client, prompt))
    onOpen?.()
  }

  const logo = (src: string, className: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={className} />
  )

  return (
    <>
    <span className="inline-flex items-center gap-1">
      {variant === 'pill' ? (
        <button
          type="button"
          className={pillClass}
          onClick={() => open(primary.id)}
          disabled={disabled}
          title={t('ai_kvittojakten_hint', { client: primary.name })}
        >
          {logo(primary.logo, 'h-3 w-3 rounded-full')}
          {t('ai_kvittojakten')}
        </button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => open(primary.id)}
          disabled={disabled}
          title={t('ai_kvittojakten_hint', { client: primary.name })}
        >
          {logo(primary.logo, 'mr-1.5 h-3.5 w-3.5 rounded-full')}
          {t('ai_kvittojakten')}
        </Button>
      )}
      {others.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {variant === 'pill' ? (
              <button type="button" className={`${pillClass} px-2`} disabled={disabled} aria-label={t('ai_fix_first_other')}>
                <ChevronDown className="h-3 w-3" aria-hidden />
              </button>
            ) : (
              <Button type="button" variant="ghost" size="sm" className="px-2" disabled={disabled} aria-label={t('ai_fix_first_other')}>
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {others.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => open(c.id)}>
                {logo(c.logo, 'mr-2 h-4 w-4')}
                {t('ai_kvittojakten_with', { client: c.name })}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
    <Dialog open={!!pendingClient} onOpenChange={(isOpen) => { if (!isOpen) setPending(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ai_kvittojakten_prereq_title')}</DialogTitle>
          <DialogDescription>
            {t('ai_kvittojakten_prereq_description', { client: pendingClient?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 text-[13px]">
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
            <span>{t('ai_kvittojakten_prereq_done', { client: pendingClient?.name ?? '' })}</span>
          </li>
          <li className="flex items-center gap-2">
            <span className="h-4 w-4 shrink-0" aria-hidden />
            <span className="text-muted-foreground">
              {t('ai_kvittojakten_prereq_mailbox', { client: pendingClient?.name ?? '' })}
            </span>
          </li>
        </ul>
        <DialogFooter>
          {pendingClient && (
            <Button type="button" variant="outline" asChild>
              <a href={pendingClient.home} target="_blank" rel="noopener noreferrer">
                {t('ai_kvittojakten_prereq_open', { client: pendingClient.name })}
                <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
              </a>
            </Button>
          )}
          {pendingClient && (
            <Button type="button" onClick={() => run(pendingClient.id)}>
              {t('ai_kvittojakten_prereq_run')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
