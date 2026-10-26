'use client'

import { useTranslations } from 'next-intl'
import {
  CheckIcon,
  ChevronDownIcon,
  ComputerDesktopIcon,
  CpuChipIcon,
  GlobeAltIcon,
  type Icon as AppIcon,
} from '@/components/icons'
import { Button, type ButtonProps } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { useClaudeTarget } from '@/components/skills/claude-target'
import { pinCompany, startInAi, type ClaudeTarget } from '@/components/skills/run'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useBranding } from '@/lib/branding/brand-context'
import { AI_CLIENTS, aiConnectAction, openAiConnector, pickConnectedAiClient, type AiClient } from '@/lib/onboarding/ai-clients'

const TARGET_ICONS: Record<ClaudeTarget, AppIcon> = { web: GlobeAltIcon, desktop: ComputerDesktopIcon, cowork: CpuChipIcon }

function Logo({ src }: { src: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="mr-1.5 h-3.5 w-3.5 rounded-full" />
}

/**
 * "Hämta med Claude": Kvittojakten in the customer's own AI, the receipt-hunt
 * hand-off the Underlag workspace and Att göra offer (KvittojaktenButton),
 * with the same prompt. It names the flow and the client and nothing else,
 * so it may travel in the chat's address; the company is pinned only where
 * no address log sees it (the clipboard, a claude:// link), as Instruktioner
 * starts a flow. The AI finds the missing underlag (in the mail, or in a
 * portal when it has a browser), uploads it and proposes the link for the
 * user to approve; nothing is linked from here.
 *
 * For Claude it is the "Starta i Claude" choice of where it opens (Claude
 * on the web, Claude Desktop, Cowork), remembered in this browser; a phone
 * opens the web. With no AI connected it reads "Koppla Claude" and opens
 * Claude's add-connector page, as the Instruktioner pages do.
 */
export function FetchWithAiButton({
  clients,
  variant,
  size,
  className,
}: {
  clients: AiClient[]
  variant: ButtonProps['variant']
  /** sm where it sits in a toolbar row (a view's heading); the default size in the focus view. */
  size?: ButtonProps['size']
  className?: string
}) {
  const t = useTranslations('inkorg')
  const tDash = useTranslations('dashboard')
  const tSkills = useTranslations('skills_registry')
  const { toast } = useToast()
  const { appName } = useBranding()
  const company = useCompanyOptional()?.company ?? null
  const [target, setTarget, targets] = useClaudeTarget()

  const clientId = pickConnectedAiClient(clients)
  const client = AI_CLIENTS.find((c) => c.id === (clientId ?? 'claude'))!

  if (!clientId) {
    return (
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => openAiConnector(aiConnectAction('claude', { origin: window.location.origin, appName }).open)}
      >
        <Logo src={client.logo} />
        {tSkills('connect_client', { client: client.name })}
      </Button>
    )
  }

  const prompt = tDash('ai_kvittojakten_prompt', { client: clientId })
  const pinned = company ? pinCompany(prompt, tSkills('prompt_company_pin', { company: company.name, companyId: company.id })) : { bare: prompt, pinned: prompt }

  // Called straight from the click, so the new tab opens inside the gesture and is not blocked.
  function start(where: ClaudeTarget) {
    void startInAi(clientId!, where, pinned, true).then((outcome) => {
      if (outcome === 'no_app') {
        setTarget('web')
        toast({ title: tSkills('no_app') })
        return
      }
      toast({
        title: t('fetch_opened', { client: client.name }),
        description: outcome === 'prefilled_copied' ? tSkills('prefilled_backup') : undefined,
      })
    })
  }

  const label = (
    <>
      <Logo src={client.logo} />
      {t('action_fetch_with_ai', { client: client.name })}
    </>
  )

  if (clientId !== 'claude' || targets.length < 2) {
    return (
      <Button variant={variant} size={size} className={className} onClick={() => start(clientId === 'claude' ? target : 'web')}>
        {label}
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          {label}
          <ChevronDownIcon aria-hidden="true" className="ml-1 h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64" aria-label={tSkills('start_where')}>
        {targets.map((where) => {
          const Icon = TARGET_ICONS[where]
          return (
            <DropdownMenuItem
              key={where}
              className="items-start gap-2 py-2"
              onSelect={() => {
                setTarget(where)
                start(where)
              }}
            >
              <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-foreground">{tSkills(`open_in_${where}`)}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{tSkills(`open_in_${where}_note`)}</span>
              </span>
              {where === target && <CheckIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
