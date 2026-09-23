'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Landmark } from 'lucide-react'
import { AiConnectorDialog } from '@/components/onboarding/AiConnectorDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { useBranding } from '@/lib/branding/brand-context'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { AI_CLIENTS, aiConnectAction, openAiConnector, type AiClient } from '@/lib/onboarding/ai-clients'

/**
 * Kopplingar: the three things Att göra can be wired to (an AI agent, the
 * bank, Skatteverket), one chip each on a single row under the list. Each
 * chip names the connection, says whether it is on, and carries the connect
 * pill while it is off; a connected chip stays as a quiet status readout.
 * What the three give is explained behind the page's "?" (convention 7),
 * not in a sentence under the row. Founder direction 2026-09-14: the connections
 * are part of the Att göra section, in the same visual language, with the
 * connect action as a pill like every other control.
 */
export function KopplingarChips({
  aiClients,
  hasBank,
  hasSkatteverket,
}: {
  aiClients: AiClient[]
  hasBank: boolean
  hasSkatteverket: boolean
}) {
  const t = useTranslations('dashboard')
  const { appName } = useBranding()
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const skvExtension = ENABLED_EXTENSION_IDS.has('skatteverket')
  const skvCapability = useCapability(CAPABILITY.skatteverket)
  const isSandbox = useCompanyOptional()?.isSandbox ?? false
  const [connectAction, setConnectAction] = useState<ReturnType<typeof aiConnectAction> | null>(null)

  // Sandbox companies cannot reach Skatteverket (the sandbox blocks it), and
  // the chip is pointless without the extension or the plan capability.
  const showSkv = skvExtension && skvCapability && !isSandbox
  const connectedAi = AI_CLIENTS.filter((c) => aiClients.includes(c.id))
  const aiOn = connectedAi.length > 0

  function connect(client: AiClient) {
    const action = aiConnectAction(client, { origin: window.location.origin, appName })
    if (action.copy) setConnectAction(action)
    else openAiConnector(action.open)
  }

  const agentLogos = (aiOn ? connectedAi : AI_CLIENTS)

  return (
    <div className="px-1 pt-4 pb-2">
      <AiConnectorDialog action={connectAction} onClose={() => setConnectAction(null)} />
      <ul aria-label={t('kopplingar_title')} className="flex flex-wrap items-center gap-2">
        <Chip
          icon={
            <span className="flex items-center -space-x-1">
              {agentLogos.map((c) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={c.id} src={c.logo} alt="" className="h-4 w-4 rounded-full bg-background ring-1 ring-background" />
              ))}
            </span>
          }
          name={aiOn ? connectedAi.map((c) => c.name).join(', ') : t('kopplingar_agent')}
          status={aiOn ? t('kopplingar_agent_on') : t('kopplingar_agent_off')}
          action={aiOn ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={pillClass} aria-label={t('kopplingar_agent_aria')}>
                  {t('kopplingar_agent_connect')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {AI_CLIENTS.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => connect(c.id)}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={c.logo} alt="" className="mr-2 h-4 w-4" />
                    {c.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        />
        <Chip
          icon={<Landmark className="h-[13px] w-[13px] text-muted-foreground" aria-hidden />}
          name={t('kopplingar_bank_short')}
          status={hasBank ? t('kopplingar_bank_on') : t('kopplingar_bank_off')}
          action={hasBank ? null : (
            <Link
              href={hasBankingExtension ? '/import?mode=psd2' : '/import?mode=bank'}
              className={pillClass}
              aria-label={t('kopplingar_bank_aria')}
            >
              {t('kopplingar_connect')}
            </Link>
          )}
        />
        {showSkv && (
          <Chip
            icon={
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/logos/skatteverket_color.svg" alt="" className="h-[13px] w-[13px]" />
            }
            name={t('kopplingar_skv_short')}
            status={hasSkatteverket ? t('kopplingar_skv_on') : t('kopplingar_skv_off')}
            action={hasSkatteverket ? null : (
              // eslint-disable-next-line @next/next/no-html-link-for-pages -- /api route, not a Next page; the authorize endpoint 302s to Skatteverket, which the client router cannot follow
              <a
                href="/api/extensions/ext/skatteverket/authorize?return_to=/"
                className={pillClass}
                aria-label={t('kopplingar_skv_aria')}
              >
                {t('kopplingar_connect')}
              </a>
            )}
          />
        )}
      </ul>
    </div>
  )
}

const pillClass =
  'inline-flex h-6 items-center rounded-full bg-secondary px-3 text-[11.5px] text-foreground transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function Chip({
  icon,
  name,
  status,
  action,
}: {
  icon: ReactNode
  name: string
  status: string
  action: ReactNode
}) {
  return (
    <li
      className={
        action
          ? 'inline-flex h-8 items-center gap-2 rounded-full border border-border pl-3 pr-1 text-[12.5px]'
          : 'inline-flex h-8 items-center gap-2 rounded-full border border-border px-3 text-[12.5px] text-muted-foreground'
      }
    >
      <span className="flex shrink-0 items-center" aria-hidden>{icon}</span>
      <span className="truncate">{name}</span>
      <span className="text-[11px] text-muted-foreground">{status}</span>
      {action}
    </li>
  )
}
