'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, aiConnectAction, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'
import { AiConnectorDialog } from '@/components/onboarding/AiConnectorDialog'

/**
 * The Klart step's connectors: one chip per client (Claude, ChatGPT, Grok),
 * each with its logo and an Anslut pill. Claude has an add-connector deep
 * link that prefills everything. ChatGPT and Grok have none: the click
 * offers a selectable server address and an explicit connector link. Same
 * URLs as Settings and the Hem checklist. A client that has completed the
 * OAuth sign-in (findings.ai.connected, polled by the Done step) turns its
 * chip into a green Ansluten mark. Founder direction 2026-09-14: no card,
 * all three visible, the connect action a pill like everything else.
 */
export function AgentChips({ connected, onConnect }: {
  connected: AiClient[]
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
              <button type="button" className="go" onClick={() => connect(c.id)} aria-label={`${t('ai_connect')} ${c.name}`}>
                {t('ai_connect')}
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
