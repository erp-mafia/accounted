'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Bot, Check } from 'lucide-react'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, aiConnectAction, openAiConnector, unknownAgentOnly, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { AiConnectorDialog } from '@/components/onboarding/AiConnectorDialog'
import { Button } from '@/components/ui/button'

/**
 * The Klart step's connectors: one chip per client (Claude, ChatGPT, Grok),
 * each with its logo and an Anslut pill. Claude has an add-connector deep
 * link that prefills everything. ChatGPT and Grok have none: the click
 * offers a selectable server address and an explicit connector link. Same
 * URLs as Settings and the Hem checklist. A client that has completed the
 * OAuth sign-in (the Done step polls /api/onboarding/ai-status) turns its
 * chip into a green Ansluten mark. Founder direction 2026-09-14: no card,
 * all three visible, the connect action a pill like everything else. An
 * agent connected with a key that names none of the three (an older key,
 * Cursor) shows as one generic connected agent instead of three offers that
 * would each fail with "a connector with this URL already exists".
 */
export function AgentChips({ connection, onConnect }: {
  connection: AiConnection
  onConnect?: (client: AiClient) => void
}) {
  const t = useTranslations('books')
  const { appName } = useBranding()
  const [connectClient, setConnectClient] = useState<AiClient | null>(null)
  const [connectAction, setConnectAction] = useState<ReturnType<typeof aiConnectAction> | null>(null)

  function connect(client: AiClient) {
    const action = aiConnectAction(client, { origin: window.location.origin, appName })
    if (action.copy) {
      setConnectClient(client)
      setConnectAction(action)
    } else {
      onConnect?.(client)
      openAiConnector(action.open)
    }
  }

  if (unknownAgentOnly(connection)) {
    return (
      <div className="agent-chips">
        <span className="agent-chip is-on">
          <Bot size={14} aria-hidden="true" />
          <span className="n">{t('ai_agent')}</span>
          <span className="st" role="status">
            <Check size={12} aria-hidden="true" />
            {t('ai_connected')}
          </span>
        </span>
      </div>
    )
  }

  const connected = connection.clients
  return (
    <div className="agent-chips">
      <AiConnectorDialog action={connectAction} onClose={() => setConnectAction(null)} onOpen={() => { if (connectClient) onConnect?.(connectClient) }} />
      {AI_CLIENTS.map((c) => {
        const on = connected.includes(c.id)
        return (
          <span key={c.id} className={`agent-chip${on ? ' is-on' : ''}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.logo} alt="" />
            <span className="n">{c.name}</span>
            {on ? (
              <span className="st" role="status">
                <Check size={12} aria-hidden="true" />
                {t('ai_connected')}
              </span>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => connect(c.id)} aria-label={`${t('ai_connect')} ${c.name}`}>
                {t('ai_connect')}
              </Button>
            )}
          </span>
        )
      })}
    </div>
  )
}
