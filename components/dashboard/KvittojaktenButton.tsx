'use client'

import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

const pillClass =
  'inline-flex h-6 shrink-0 items-center gap-2 rounded-full bg-primary px-3 text-[11.5px] text-primary-foreground transition-colors duration-150 hover:bg-primary/85 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

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

  const connected = AI_CLIENTS.filter((c) => clients.includes(c.id))
  if (connected.length === 0) return null

  const primaryId = pickConnectedAiClient(clients, preferredClient)
  const primary = connected.find((client) => client.id === primaryId)!
  const others = connected.filter((client) => client.id !== primaryId)

  function open(client: AiClient) {
    if (disabled) return
    const prompt = t('ai_kvittojakten_prompt', { skill: kvittojaktenSkillSlug(client) })
    openAiConnector(aiPrefilledChatLink(client, prompt))
    onOpen?.()
  }

  const logo = (src: string, className: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={className} />
  )

  return (
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
  )
}
