'use client'

import { useTranslations } from 'next-intl'
import { ChevronDownIcon } from '@/components/icons'
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
  openAiConnector,
  pickConnectedAiClient,
  type AiClient,
} from '@/lib/onboarding/ai-clients'

/**
 * The onboarding import (skill company-facts-import): once an AI client is
 * connected, one click opens it with the prompt typed in, and it tells
 * Accounted what it already remembers about the business. The AI shows the
 * list and saves only what the user confirms, so the chat is the review.
 *
 * The prompt names the skill and nothing else, so it may travel in the chat
 * URL (aiPrefilledChatLink's rule): the AI learns the company over MCP.
 * Renders nothing while no client is connected.
 */
export function FactsImport({
  clients,
  preferredClient,
  disabled = false,
  quiet = false,
}: {
  clients: AiClient[]
  preferredClient?: AiClient
  disabled?: boolean
  /** One quiet line: the sentence followed by the action as a text link, no outlined buttons. */
  quiet?: boolean
}) {
  const t = useTranslations('books')

  const connected = AI_CLIENTS.filter((c) => clients.includes(c.id))
  if (connected.length === 0) return null

  const primaryId = pickConnectedAiClient(clients, preferredClient)
  const primary = connected.find((client) => client.id === primaryId)!
  const others = connected.filter((client) => client.id !== primaryId)

  function open(client: AiClient) {
    if (disabled) return
    openAiConnector(aiPrefilledChatLink(client, t('facts_import_prompt')))
  }

  const logo = (src: string, className: string) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={className} />
  )

  if (quiet) {
    return (
      <div className="found-note">
        {t('facts_import_quiet_lead', { client: primary.name })}{' '}
        <Button type="button" variant="link" className="text-[length:inherit]" onClick={() => open(primary.id)} disabled={disabled}>
          {t('facts_import_quiet')}
        </Button>
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="link" className="ml-1 text-[length:inherit]" disabled={disabled} aria-label={t('facts_import_other')}>
                <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {others.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => open(c.id)}>
                  {logo(c.logo, 'mr-2 h-4 w-4')}
                  {t('facts_import_with', { client: c.name })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    )
  }

  return (
    <div className="found-note">
      {t('facts_import_lead', { client: primary.name })}{' '}
      <span className="inline-flex items-center gap-1">
        <Button type="button" variant="outline" onClick={() => open(primary.id)} disabled={disabled}>
          {logo(primary.logo, 'mr-1.5 h-3.5 w-3.5 rounded-full')}
          {t('facts_import', { client: primary.name })}
        </Button>
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" disabled={disabled} aria-label={t('facts_import_other')}>
                <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {others.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => open(c.id)}>
                  {logo(c.logo, 'mr-2 h-4 w-4')}
                  {t('facts_import_with', { client: c.name })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    </div>
  )
}
