'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SettingsSeg } from '@/components/settings/SettingsRows'
import { CopyBlock } from '@/components/settings/CopyBlock'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { claudeConnectorLink, mcpServerUrl, sideDoorServerUrl } from '@/lib/onboarding/checklist'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()
const connectorName = branding.appName.toLowerCase()

/** The clients the Settings tiles offer, in display order. */
export const CONNECT_TARGETS = ['claude', 'chatgpt', 'grok', 'claude-code', 'cursor', 'other'] as const
export type ConnectTarget = (typeof CONNECT_TARGETS)[number]

/**
 * One way of connecting a client: its numbered steps (i18n `steps_<set>_<n>`
 * with a `_note` each) and the snippet to copy. A client with more than one
 * way (claude.ai sign-in vs Claude Desktop with a key) offers them as modes.
 */
type StepSet =
  | 'claude_signin'
  | 'claude_desktop'
  | 'chatgpt'
  | 'grok'
  | 'code_plugin'
  | 'code_signin'
  | 'code_key'
  | 'cursor'
  | 'other'

interface Mode {
  set: StepSet
  steps: number
  /** i18n key for the mode's segment label; omitted when there is one mode. */
  label?: string
  snippet: (origin: string) => string
  /** i18n key for a line above the snippet. */
  snippetLabel?: string
}

const MODES: Record<ConnectTarget, Mode[]> = {
  claude: [
    {
      set: 'claude_signin',
      steps: 3,
      label: 'mode_signin',
      // claude.ai's Add-custom-connector dialog probes the URL without
      // credentials and pre-fills Authentication "None" when the lazy
      // handshake answers 200, which blocks the sign-in later. The eager
      // flag makes every tokenless request answer the 401 challenge
      // (extensions/general/mcp-server/auth-mode.ts).
      snippet: (origin) => mcpServerUrl({ origin, client: 'claude-connector', eagerAuth: true }),
      snippetLabel: 'claude_manual_label',
    },
    {
      set: 'claude_desktop',
      steps: 3,
      label: 'mode_desktop_key',
      // ACCOUNTED_URL is emitted so self-hosted and white-label instances get
      // a config that points at their own host: the bridge otherwise defaults
      // to the hosted endpoint. The key value keeps the `gnubok_sk_` wire
      // prefix on purpose.
      snippet: (origin) => `{
  "mcpServers": {
    "${connectorName}": {
      "command": "npx",
      "args": ["-y", "accounted-mcp"],
      "env": {
        "ACCOUNTED_API_KEY": "gnubok_sk_...",
        "ACCOUNTED_URL": "${mcpServerUrl({ origin, client: 'claude-desktop' })}",
        "ACCOUNTED_CLIENT": "claude-desktop"
      }
    }
  }
}`,
    },
  ],
  // ChatGPT's developer mode honours the lazy 401 and keeps the plain URL;
  // Grok's dialog probes like claude.ai's and needs the eager flag.
  // sideDoorServerUrl owns that difference.
  chatgpt: [{ set: 'chatgpt', steps: 3, snippet: (origin) => sideDoorServerUrl({ origin, door: 'chatgpt' }) }],
  grok: [{ set: 'grok', steps: 3, snippet: (origin) => sideDoorServerUrl({ origin, door: 'grok' }) }],
  'claude-code': [
    {
      set: 'code_plugin',
      steps: 2,
      label: 'mode_plugin',
      snippet: () => '/plugin marketplace add erp-mafia/accounted\n/plugin install accounted@accounted',
    },
    {
      set: 'code_signin',
      steps: 2,
      label: 'mode_signin',
      // URL is quoted: unquoted `?` in the query string trips zsh globbing.
      snippet: (origin) =>
        `claude mcp add --transport http ${connectorName} "${mcpServerUrl({ origin, client: 'claude-code' })}"`,
    },
    {
      set: 'code_key',
      steps: 2,
      label: 'mode_key',
      snippet: (origin) => `claude mcp add --transport http ${connectorName} \\
  "${mcpServerUrl({ origin, client: 'claude-code' })}" \\
  --header "Authorization: Bearer gnubok_sk_..."`,
    },
  ],
  cursor: [
    {
      set: 'cursor',
      steps: 3,
      snippet: (origin) => `{
  "mcpServers": {
    "${connectorName}": {
      "url": "${mcpServerUrl({ origin, client: 'cursor' })}"
    }
  }
}`,
    },
  ],
  other: [{ set: 'other', steps: 3, snippet: (origin) => mcpServerUrl({ origin, client: 'other' }) }],
}

/** Where the dialog's "Open" button goes, for clients that have a page to open. */
function openHref(target: ConnectTarget, origin: string): string | null {
  switch (target) {
    case 'claude':
      // Opens Add-custom-connector with name and URL prefilled. It only
      // prefills the dialog, so the user still reviews and confirms, and
      // Anthropic's cloud must be able to reach the URL: on localhost or a
      // firewalled self-host the pasted address is the path.
      return claudeConnectorLink({ origin, appName: branding.appName })
    case 'chatgpt':
    case 'grok':
      return AI_CLIENTS.find((c) => c.id === target)?.home ?? null
    default:
      return null
  }
}

/** Display name for a tile/dialog: the shared AI_CLIENTS name, else an i18n label. */
export function useConnectTargetName(): (target: ConnectTarget) => string {
  const t = useTranslations('settings_api_keys')
  return (target) => AI_CLIENTS.find((c) => c.id === target)?.name ?? t(`target_${target.replace('-', '_')}`)
}

export function ConnectClientDialog({
  target,
  origin,
  onClose,
}: {
  target: ConnectTarget | null
  /** window.location.origin, resolved after mount; '' until then. */
  origin: string
  onClose: () => void
}) {
  const t = useTranslations('settings_api_keys')
  const targetName = useConnectTargetName()
  const [modeIndex, setModeIndex] = useState(0)

  const modes = target ? MODES[target] : []
  const mode = modes[modeIndex] ?? modes[0]
  const href = target && origin ? openHref(target, origin) : null
  const name = target ? targetName(target) : ''

  function close() {
    setModeIndex(0)
    onClose()
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('connect_dialog_title', { name })}</DialogTitle>
          <DialogDescription>{t('connect_dialog_description')}</DialogDescription>
        </DialogHeader>

        {mode && (
          <div className="min-w-0 space-y-4">
            {modes.length > 1 && (
              <SettingsSeg
                aria-label={t('connect_mode_aria')}
                value={String(modeIndex)}
                onChange={(v) => setModeIndex(Number(v))}
                options={modes.map((m, i) => ({ value: String(i), label: t(m.label ?? 'mode_signin') }))}
              />
            )}

            <ol className="space-y-2">
              {Array.from({ length: mode.steps }, (_, i) => i + 1).map((n) => (
                <li key={n} className="grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-3 text-sm">
                  <span className="inline-grid h-5 w-5 place-items-center rounded-full border border-border text-[11px] tabular-nums text-muted-foreground">
                    {n}
                  </span>
                  <span>
                    {t(`steps_${mode.set}_${n}`, { appName: branding.appName })}
                    <span className="text-muted-foreground">
                      {' · '}
                      {t(`steps_${mode.set}_${n}_note`, { appName: branding.appName })}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            {mode.snippetLabel && (
              <p className="text-xs text-muted-foreground">{t(mode.snippetLabel)}</p>
            )}
            {origin ? <CopyBlock text={mode.snippet(origin)} copyAriaLabel={t('copy_aria')} /> : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('done')}
          </Button>
          {href && mode?.set !== 'claude_desktop' && (
            <Button asChild>
              <a href={href} target="_blank" rel="noopener noreferrer">
                {t('connect_open', { name })}
                <ArrowUpRight className="ml-1.5 h-4 w-4" />
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
