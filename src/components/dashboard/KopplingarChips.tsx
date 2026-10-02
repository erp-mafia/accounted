'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Bot, Landmark } from 'lucide-react'
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
import { AI_CLIENTS, agentChipView, aiConnectAction, openAiConnector, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { useOmbudAppointWithToasts } from '@/components/skatteverket/ombud-appoint'

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
  aiConnection,
  hasBank,
  hasSkatteverket,
  skvOmbudEnabled = false,
}: {
  aiConnection: AiConnection
  hasBank: boolean
  hasSkatteverket: boolean
  /**
   * Accounted can be the company's ombud (system auth on): the pill appoints
   * it at Skatteverket instead of starting an hourly BankID session.
   */
  skvOmbudEnabled?: boolean
}) {
  const t = useTranslations('dashboard')
  const { appName } = useBranding()
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const skvExtension = ENABLED_EXTENSION_IDS.has('skatteverket')
  const skvCapability = useCapability(CAPABILITY.skatteverket)
  const isSandbox = useCompanyOptional()?.isSandbox ?? false
  const [connectAction, setConnectAction] = useState<ReturnType<typeof aiConnectAction> | null>(null)
  const router = useRouter()
  const ombud = useOmbudAppointWithToasts((result) => {
    if (result === 'granted') router.refresh()
  })
  const tOmbud = useTranslations('skatteverket_ombud')

  // Sandbox companies cannot reach Skatteverket (the sandbox blocks it), and
  // the chip is pointless without the extension or the plan capability.
  const showSkv = skvExtension && skvCapability && !isSandbox
  // On for any connected agent, named ones or not (agentChipView): an agent
  // connected through a client we cannot name still reads as connected.
  const agentChip = agentChipView(aiConnection)
  const aiOn = agentChip.on
  const agentLogos = AI_CLIENTS.filter((c) => agentChip.logos.includes(c.id))
  const agentNames = AI_CLIENTS.filter((c) => agentChip.named.includes(c.id)).map((c) => c.name)

  function connect(client: AiClient) {
    const action = aiConnectAction(client, { origin: window.location.origin, appName })
    if (action.copy) setConnectAction(action)
    else openAiConnector(action.open)
  }

  return (
    <div className="px-1 pt-4 pb-2">
      <AiConnectorDialog action={connectAction} onClose={() => setConnectAction(null)} />
      <ul aria-label={t('kopplingar_title')} className="flex flex-wrap items-center gap-2">
        <Chip
          icon={
            agentLogos.length > 0 ? (
              <span className="flex items-center -space-x-1">
                {agentLogos.map((c) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={c.id} src={c.logo} alt="" className="h-4 w-4 rounded-full bg-background ring-1 ring-background" />
                ))}
              </span>
            ) : (
              <Bot className="h-[13px] w-[13px] text-muted-foreground" aria-hidden />
            )
          }
          name={agentNames.length > 0 ? agentNames.join(', ') : t('kopplingar_agent')}
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
            action={hasSkatteverket ? null : skvOmbudEnabled ? (
              <button
                type="button"
                onClick={() => void ombud.appoint()}
                disabled={ombud.linking || ombud.checking}
                className={pillClass}
                aria-label={tOmbud('appoint', { appName })}
                title={tOmbud('appoint_hint', { appName })}
              >
                {t('kopplingar_connect')}
              </button>
            ) : (
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
  'inline-flex h-6 items-center rounded-full bg-secondary px-3 text-[11px] text-foreground transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

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
