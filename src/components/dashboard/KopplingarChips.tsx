'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { BuildingLibraryIcon } from '@/components/icons'
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
import { AI_CLIENTS, agentChipView, aiConnectAction, aiPrefilledChatLink, openAiConnector, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { useOmbudAppointWithToasts } from '@/components/skatteverket/ombud-appoint'
import { trackInstructions } from '@/components/skills/track'

/**
 * Kopplingar: the three things Att göra can be wired to (an AI agent, the
 * bank, Skatteverket), one chip each on a single row under the list, for the
 * ones that are NOT connected: the chip names the connection, says it is off
 * and carries the connect pill. A connected one renders nothing, and with
 * all three connected the row is gone: "connected" is the normal state, and
 * a chip on every visit saying so marks nothing (convention 5). While the
 * agent is off its chip is Hem's one agent prompt (DashboardContent holds
 * AgentPromo back until an agent is connected). What the three give is
 * explained behind the page's "?" (convention 7), not in a sentence under
 * the row. Product direction 2026-09-14: the connections are part of the Att
 * göra section, in the same visual language, with the connect action as a
 * pill like every other control.
 *
 * One connected state does render: `firstTask`, an agent that has a key but
 * has never been asked anything. That is the exception here, not the normal
 * state: the sign-in ends on the client's settings page, so this chip is what
 * turns a connection into a first question. It opens a new chat with a fixed
 * prompt and goes away by itself after the agent's first working call.
 */
export function KopplingarChips({
  aiConnection,
  firstTask = null,
  firstTaskOnly = false,
  hasBank,
  hasSkatteverket,
  skvOmbudEnabled = false,
  skvOmbudWaiting = false,
}: {
  aiConnection: AiConnection
  /** The connected client to ask for a first task (lib/onboarding/ai-clients firstTaskClient). */
  firstTask?: AiClient | null
  /** Only that chip: while the checklist is open it carries the connect offers. */
  firstTaskOnly?: boolean
  hasBank: boolean
  hasSkatteverket: boolean
  /**
   * Accounted can be the company's ombud (system auth on): the pill appoints
   * it at Skatteverket instead of starting an hourly BankID session.
   */
  skvOmbudEnabled?: boolean
  /**
   * The company appointed it and Skatteverket's register does not list the
   * grant yet: the chip says it is waiting, and the pill opens the link again
   * for someone who did not finish signing.
   */
  skvOmbudWaiting?: boolean
}) {
  const t = useTranslations('dashboard')
  const { appName } = useBranding()
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const skvExtension = ENABLED_EXTENSION_IDS.has('skatteverket')
  const skvCapability = useCapability(CAPABILITY.skatteverket)
  const isSandbox = useCompanyOptional()?.isSandbox ?? false
  const [connectAction, setConnectAction] = useState<ReturnType<typeof aiConnectAction> | null>(null)
  const router = useRouter()
  // Every finished check re-renders: granted hides the chip, a wait shows it.
  const ombud = useOmbudAppointWithToasts(() => router.refresh())
  const tOmbud = useTranslations('skatteverket_ombud')

  // Sandbox companies cannot reach Skatteverket (the sandbox blocks it), and
  // the chip is pointless without the extension or the plan capability.
  const showSkv = skvExtension && skvCapability && !isSandbox
  // On for any connected agent, named ones or not (agentChipView): an agent
  // connected through a client we cannot name still reads as connected. Off,
  // the chip shows the three connectable logos.
  const agentChip = agentChipView(aiConnection)
  const showAgent = !firstTaskOnly && !agentChip.on
  const agentLogos = AI_CLIENTS.filter((c) => agentChip.logos.includes(c.id))
  // Connecting the bank or Skatteverket is a write: not offered to a read-only member.
  const canWrite = useCompanyOptional()?.role !== 'viewer'
  const showBank = canWrite && !firstTaskOnly && !hasBank
  const showSkvChip = canWrite && !firstTaskOnly && showSkv && !hasSkatteverket
  const firstTaskAgent = AI_CLIENTS.find((c) => c.id === firstTask)

  function connect(client: AiClient) {
    const action = aiConnectAction(client, { origin: window.location.origin, appName })
    if (action.copy) setConnectAction(action)
    else openAiConnector(action.open)
  }

  function askFirstQuestion(client: AiClient) {
    trackInstructions('instructions_start_clicked', { item: 'first_task', kind: 'workflow', client, surface: 'hem', target: 'web' })
    openAiConnector(aiPrefilledChatLink(client, t('kopplingar_agent_first_task_prompt')))
  }

  if (!showAgent && !firstTaskAgent && !showBank && !showSkvChip) return null

  return (
    // No padding of its own: Hem's section rhythm (32px) spaces it like every other block.
    <div>
      <AiConnectorDialog action={connectAction} onClose={() => setConnectAction(null)} />
      <ul aria-label={t('kopplingar_title')} className="flex flex-wrap items-center gap-2">
        {showAgent && (
          <Chip
            icon={
              <span className="flex items-center -space-x-1">
                {agentLogos.map((c) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={c.id} src={c.logo} alt="" className="h-4 w-4 rounded-full bg-background ring-1 ring-background" />
                ))}
              </span>
            }
            name={t('kopplingar_agent')}
            status={t('kopplingar_agent_off')}
            action={
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
            }
          />
        )}
        {firstTaskAgent && (
          <Chip
            // eslint-disable-next-line @next/next/no-img-element
            icon={<img src={firstTaskAgent.logo} alt="" className="h-4 w-4 rounded-full bg-background ring-1 ring-background" />}
            name={firstTaskAgent.name}
            status={t('kopplingar_agent_on')}
            action={
              <button
                type="button"
                onClick={() => askFirstQuestion(firstTaskAgent.id)}
                className={pillClass}
                aria-label={t('kopplingar_agent_first_task_aria', { client: firstTaskAgent.name })}
                title={t('kopplingar_agent_first_task_hint', { client: firstTaskAgent.name })}
              >
                {t('kopplingar_agent_first_task')}
              </button>
            }
          />
        )}
        {showBank && (
          <Chip
            icon={<BuildingLibraryIcon className="h-[13px] w-[13px] text-muted-foreground" aria-hidden />}
            name={t('kopplingar_bank_short')}
            status={t('kopplingar_bank_off')}
            action={
              <Link
                href={hasBankingExtension ? '/import?mode=psd2' : '/import?mode=bank'}
                className={pillClass}
                aria-label={t('kopplingar_bank_aria')}
              >
                {t('kopplingar_connect')}
              </Link>
            }
          />
        )}
        {showSkvChip && (
          <Chip
            icon={<BuildingLibraryIcon className="h-[13px] w-[13px] text-muted-foreground" aria-hidden />}
            name={t('kopplingar_skv_short')}
            status={skvOmbudEnabled && skvOmbudWaiting ? t('kopplingar_skv_waiting') : t('kopplingar_skv_off')}
            action={skvOmbudEnabled ? (
              <button
                type="button"
                onClick={() => void ombud.appoint()}
                disabled={ombud.linking || ombud.checking}
                className={pillClass}
                aria-label={tOmbud('appoint', { appName })}
                title={skvOmbudWaiting ? tOmbud('waiting_hint', { appName }) : tOmbud('appoint_hint', { appName })}
              >
                {skvOmbudWaiting ? t('kopplingar_skv_reopen') : t('kopplingar_connect')}
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
  'inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-strong transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-40'

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
    <li className="inline-flex h-8 items-center gap-2 rounded-md bg-control pl-3 pr-1 text-xs shadow-raised">
      <span className="flex shrink-0 items-center" aria-hidden>{icon}</span>
      <span className="truncate">{name}</span>
      <span className="text-xs text-muted-foreground">{status}</span>
      {action}
    </li>
  )
}
