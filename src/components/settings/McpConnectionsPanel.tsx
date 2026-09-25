'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useSyncExternalStore } from 'react'
import { ArrowUpRight, KeyRound, Loader2, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AttnLine } from '@/components/ui/attn-line'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { SettingsGroup } from '@/components/settings/SettingsRows'
import {
  CONNECT_TARGETS,
  ConnectClientDialog,
  useConnectTargetName,
  type ConnectTarget,
} from '@/components/settings/ConnectClientDialog'
import type { ApiKeyRow } from '@/components/settings/useApiKeys'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import { claudeConnectorLink } from '@/lib/onboarding/checklist'
import { getBranding } from '@/lib/branding/service'
import { ALL_SCOPES } from '@/lib/auth/scope-catalog'
import { STALE_AFTER_DAYS, connectionKind, isStaleConnection, type ConnectionKind } from '@/lib/settings/mcp-connections'
import { cn, formatDateLong } from '@/lib/utils'

const branding = getBranding()

// The origin never changes while the page is open: nothing to subscribe to.
const noopSubscribe = () => () => {}
const clientOrigin = () => window.location.origin
const serverOrigin = () => ''

const LOGO: Partial<Record<ConnectionKind | ConnectTarget, string>> = {
  claude: AI_CLIENTS.find((c) => c.id === 'claude')?.logo,
  chatgpt: AI_CLIENTS.find((c) => c.id === 'chatgpt')?.logo,
  grok: AI_CLIENTS.find((c) => c.id === 'grok')?.logo,
  // Claude Code carries Anthropic's Claude mark; it is the same product family.
  'claude-code': AI_CLIENTS.find((c) => c.id === 'claude')?.logo,
}

/**
 * Single-colour brand marks drawn in currentColor, so they follow the theme
 * (a black <img> would vanish in dark mode). Path data from simple-icons
 * 16.32.0, CC0-1.0: Cursor's mark, and the Model Context Protocol mark for a
 * generic MCP client.
 */
function CursorMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  )
}

function McpMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245" />
    </svg>
  )
}

const ICON = {
  local: Terminal,
  cursor: CursorMark,
  mcp: McpMark,
  other: McpMark,
  key: KeyRound,
} as const

/** A client's mark in a round well: the logo where we ship one, else a Lucide glyph. */
function ClientMark({ kind, size = 'md' }: { kind: ConnectionKind | ConnectTarget; size?: 'md' | 'lg' }) {
  const logo = LOGO[kind]
  const Icon = ICON[kind as keyof typeof ICON] ?? McpMark
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full border border-border bg-background',
        size === 'lg' ? 'h-8 w-8' : 'h-6 w-6',
      )}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo} alt="" className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
      ) : (
        <Icon className={cn(kind === 'local' || kind === 'key' ? 'text-muted-foreground' : 'text-foreground', size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5')} />
      )}
    </span>
  )
}

/**
 * Settings → API & MCP, the part a non-developer uses: what is connected to
 * the books, and how to connect one more. Connections are the company's live
 * API keys: sign-ins from the MCP OAuth flow (one per client sign-in) and
 * keys made by hand under Utvecklare. With nothing connected, Claude is the
 * hero: it is the path for nearly everyone and the only one-click link.
 */
export function McpConnectionsPanel({
  keys,
  isLoading,
  onRevoke,
}: {
  keys: ApiKeyRow[]
  isLoading: boolean
  onRevoke: (id: string, toastTitle: string) => Promise<void>
}) {
  const t = useTranslations('settings_api_keys')
  const locale = useLocale()
  const targetName = useConnectTargetName()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [target, setTarget] = useState<ConnectTarget | null>(null)

  // This panel is server-rendered before it hydrates, and window.location has
  // no server equivalent. Reading the origin at render time therefore yields a
  // relative URL in the first paint, and a click on the install link in that
  // window would hand claude.ai a connectorUrl it cannot resolve. Resolve the
  // origin after mount and withhold the link's href until it is known.
  const origin = useSyncExternalStore(noopSubscribe, clientOrigin, serverOrigin)

  const now = new Date()
  const stale = keys.filter((k) => isStaleConnection(k, now))

  function rowName(key: ApiKeyRow): string {
    const kind = connectionKind(key)
    if (kind === 'key') return key.name
    if (kind === 'claude' || kind === 'chatgpt' || kind === 'grok') return targetName(kind)
    return t(`kind_${kind}`)
  }

  async function disconnect(key: ApiKeyRow) {
    const isSignin = key.source === 'signin'
    const name = rowName(key)
    const ok = await confirm(
      isSignin
        ? {
            title: t('disconnect_dialog_title', { name }),
            description: t('disconnect_dialog_description', { name }),
            confirmLabel: t('disconnect_confirm'),
          }
        : {
            title: t('revoke_dialog_title'),
            description: t('revoke_dialog_description', { name }),
            confirmLabel: t('revoke_confirm'),
          },
    )
    if (!ok) return
    await onRevoke(key.id, isSignin ? t('toast_disconnected', { name }) : t('toast_revoked'))
  }

  const tiles = (exclude?: ConnectTarget) => (
    <div className="grid grid-cols-2 gap-2 pt-3 sm:grid-cols-3">
      {CONNECT_TARGETS.filter((c) => c !== exclude).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => setTarget(c)}
          className="flex min-h-[60px] items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors duration-150 hover:bg-secondary/60"
        >
          <ClientMark kind={c} size="lg" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{targetName(c)}</span>
            <span className="block truncate text-[12.5px] text-muted-foreground">{t(`tile_${c.replace('-', '_')}_sub`)}</span>
          </span>
        </button>
      ))}
    </div>
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      {keys.length === 0 ? (
        <>
          <SettingsGroup>
            <div className="grid gap-6 rounded-lg border border-border p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-8">
              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-3">
                  <ClientMark kind="claude" size="lg" />
                  <h3 className="font-display text-xl tracking-tight">{t('hero_title')}</h3>
                </div>
                <p className="max-w-prose text-[13px] text-muted-foreground">{t('hero_body')}</p>
                <ol className="mt-4 space-y-2">
                  {[1, 2, 3].map((n) => (
                    <li key={n} className="grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-3 text-[13px]">
                      <span className="inline-grid h-5 w-5 place-items-center rounded-full border border-border text-[11px] tabular-nums text-muted-foreground">
                        {n}
                      </span>
                      <span>
                        {t(`steps_claude_signin_${n}`)}
                        <span className="text-muted-foreground">
                          {' · '}
                          {t(`steps_claude_signin_${n}_note`)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="flex flex-col items-start gap-3">
                <Button asChild size="lg">
                  <a
                    href={origin ? claudeConnectorLink({ origin, appName: branding.appName }) : undefined}
                    aria-disabled={!origin}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('connect_to_claude')}
                    <ArrowUpRight className="ml-1.5 h-4 w-4" />
                  </a>
                </Button>
                <button
                  type="button"
                  onClick={() => setTarget('claude')}
                  className="text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
                >
                  {t('hero_manual')}
                </button>
                {/* The step-by-step guide is canonical on the docs site, in one
                    language per URL. Root-relative so the /docs/api/* 308 in
                    next.config.ts forwards to docs.gnubok.se (issue #2133). */}
                <a
                  href={locale === 'sv' ? '/docs/api/anslut-claude' : '/docs/api/connect-claude'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
                >
                  {t('full_guide_link')}
                  <ArrowUpRight className="h-3 w-3" />
                </a>
              </div>
            </div>
          </SettingsGroup>
          <SettingsGroup label={t('something_else')}>{tiles('claude')}</SettingsGroup>
        </>
      ) : (
        <>
          <SettingsGroup label={t('connections_title')}>
            <ul className="pt-2">
              {keys.map((key) => {
                const kind = connectionKind(key)
                const scopeCount = key.scopes?.length ?? 0
                const permissionSummary =
                  scopeCount === ALL_SCOPES.length
                    ? t('all_permissions')
                    : scopeCount === 0
                      ? t('no_permissions')
                      : t('permissions_count', { count: scopeCount })
                return (
                  <li key={key.id} className="flex items-center gap-3 border-b border-border px-1 py-2">
                    <ClientMark kind={kind} />
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
                      <span className="truncate">{rowName(key)}</span>
                      {key.mode === 'test' && (
                        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">
                          {t('badge_test')}
                        </Badge>
                      )}
                    </span>
                    <span className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground md:block">
                      {kind === 'key' ? (
                        <span className="font-mono">{key.key_prefix}...</span>
                      ) : (
                        t('via_signin')
                      )}
                    </span>
                    <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground lg:block">
                      {permissionSummary}
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {key.last_used_at ? formatDateLong(key.last_used_at, locale) : t('never_used')}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => disconnect(key)}
                      aria-label={t('disconnect_aria', { name: rowName(key) })}
                    >
                      {key.source === 'signin' ? t('disconnect') : t('revoke_confirm')}
                    </Button>
                  </li>
                )
              })}
            </ul>
            {stale.length > 0 && (
              <AttnLine className="px-1 pt-3">
                {stale.length === 1
                  ? t('stale_one', { name: rowName(stale[0]), days: STALE_AFTER_DAYS })
                  : t('stale_many', { count: stale.length, days: STALE_AFTER_DAYS })}
              </AttnLine>
            )}
          </SettingsGroup>
          <SettingsGroup label={t('add_connection')}>{tiles()}</SettingsGroup>
        </>
      )}

      <ConnectClientDialog target={target} origin={origin} onClose={() => setTarget(null)} />
      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}
