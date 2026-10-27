'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useSyncExternalStore } from 'react'
import {
  ArrowUpRightIcon,
  BuildingOfficeIcon,
  CommandLineIcon,
  KeyIcon,
  SpinnerIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AttnLine } from '@/components/ui/attn-line'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { SettingsGroup, SettingsSeg } from '@/components/settings/SettingsRows'
import {
  CLAUDE_CONNECTORS_HOME,
  CONNECT_TARGETS,
  ConnectClientDialog,
  useConnectTargetName,
  type ConnectTarget,
} from '@/components/settings/ConnectClientDialog'
import type { ApiKeyRow } from '@/components/settings/useApiKeys'
import type { PickerCompany } from '@/components/settings/CompanyPickerList'
import { KeyCompaniesDialog } from '@/components/settings/KeyCompaniesDialog'
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
 * 16.32.0, CC0-1.0: Cursor's and Google Gemini's marks, and the Model Context
 * Protocol mark for a generic MCP client.
 */
function CursorMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  )
}

function GeminiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
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
  local: CommandLineIcon,
  cursor: CursorMark,
  gemini: GeminiMark,
  mcp: McpMark,
  other: McpMark,
  key: KeyIcon,
} as const

/** A client's mark in a round well: the logo where we ship one, else an icon. */
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
 * API keys (from the byrå cockpit: the person's own, across every client):
 * sign-ins from the MCP OAuth flow (one per client sign-in) and
 * keys made by hand under Utvecklare. With nothing connected, Claude is the
 * hero: it is the path for nearly everyone and the only one-click link.
 */
export function McpConnectionsPanel({
  keys,
  companies = [],
  isLoading,
  onRevoke,
  onKeysChanged,
}: {
  keys: ApiKeyRow[]
  /** The caller's companies (useApiKeys): with two or more, each row shows and edits its company reach. */
  companies?: PickerCompany[]
  isLoading: boolean
  onRevoke: (id: string, toastTitle: string) => Promise<void>
  /** Re-read the keys after a row's companies were edited. */
  onKeysChanged?: () => void
}) {
  const t = useTranslations('settings_api_keys')
  const locale = useLocale()
  const targetName = useConnectTargetName()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [target, setTarget] = useState<ConnectTarget | null>(null)
  const [dialogSet, setDialogSet] = useState<'claude_signin' | 'claude_team' | undefined>(undefined)
  // Which Claude the viewer is on, once they say so; until then it is guessed below.
  const [claudePlan, setClaudePlan] = useState<'personal' | 'team' | null>(null)
  const [editingCompanies, setEditingCompanies] = useState<ApiKeyRow | null>(null)
  // Only meaningful for a multi-company user: "Alla företag" on a
  // single-company account would be noise.
  const hasCompanyPicker = companies.length >= 2

  // This panel is server-rendered before it hydrates, and window.location has
  // no server equivalent. Reading the origin at render time therefore yields a
  // relative URL in the first paint, and a click on the install link in that
  // window would hand claude.ai a connectorUrl it cannot resolve. Resolve the
  // origin after mount and withhold the link's href until it is known.
  const origin = useSyncExternalStore(noopSubscribe, clientOrigin, serverOrigin)

  const now = new Date()
  const stale = keys.filter((k) => isStaleConnection(k, now))
  // A company admin also sees the other members' keys (api_keys_select), but
  // a colleague's Claude is not the viewer's: every person signs in on their
  // own. The Claude hero therefore stays up until the viewer has a connection
  // of their own, and a colleague's row says whose it is. Rows without is_own
  // count as the viewer's.
  const hasOwnConnection = keys.some((k) => k.is_own !== false)
  const isColleagues = (key: ApiKeyRow) => key.is_own === false && !key.service_account
  // A colleague already on Claude almost always means a Claude Team or
  // Enterprise organisation where the owner added the connector: there the
  // viewer clicks Connect on it instead of adding a second one (only owners
  // can add custom connectors on those plans).
  const colleagueClaude = keys.find((k) => isColleagues(k) && connectionKind(k) === 'claude')
  const colleagueOnClaude = colleagueClaude !== undefined
  const plan = claudePlan ?? (colleagueOnClaude ? 'team' : 'personal')

  function openDialog(next: ConnectTarget, set?: 'claude_signin' | 'claude_team') {
    setDialogSet(set ?? (next === 'claude' && colleagueOnClaude ? 'claude_team' : undefined))
    setTarget(next)
  }

  function rowName(key: ApiKeyRow): string {
    const kind = connectionKind(key)
    if (kind === 'key') return key.name
    if (kind === 'claude' || kind === 'chatgpt' || kind === 'grok' || kind === 'gemini') return targetName(kind)
    return t(`kind_${kind}`)
  }

  async function disconnect(key: ApiKeyRow) {
    const isSignin = key.source === 'signin'
    const name = rowName(key)
    const ok = await confirm(
      isSignin
        ? {
            title: t('disconnect_dialog_title', { name }),
            description: isColleagues(key)
              ? t('disconnect_dialog_description_colleague', { name, owner: key.owner_name ?? t('colleague_fallback') })
              : t('disconnect_dialog_description', { name }),
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
          onClick={() => openDialog(c)}
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
        <SpinnerIcon className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      {!hasOwnConnection && (
        <SettingsGroup>
          <div className="grid gap-6 rounded-lg border border-border p-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-8">
            <div className="min-w-0">
              <div className="mb-3 flex items-center gap-3">
                <ClientMark kind="claude" size="lg" />
                <h3 className="font-display text-xl tracking-tight">{t(colleagueOnClaude ? 'hero_title_own' : 'hero_title')}</h3>
              </div>
              <p className="max-w-prose text-[13px] text-muted-foreground">
                {plan === 'personal'
                  ? t('hero_body')
                  : colleagueClaude?.owner_name
                    ? t('hero_body_team_colleague_named', { appName: branding.appName, owner: colleagueClaude.owner_name })
                    : t(colleagueOnClaude ? 'hero_body_team_colleague' : 'hero_body_team', { appName: branding.appName })}
              </p>
              <div className="mt-4">
                <SettingsSeg
                  aria-label={t('hero_plan_aria')}
                  value={plan}
                  onChange={setClaudePlan}
                  options={[
                    { value: 'personal', label: t('hero_plan_personal') },
                    { value: 'team', label: t('hero_plan_team') },
                  ]}
                />
              </div>
              <ol className="mt-4 space-y-2">
                {[1, 2, 3].map((n) => {
                  const set = plan === 'team' ? 'claude_team' : 'claude_signin'
                  return (
                    <li key={n} className="grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-3 text-[13px]">
                      <span className="inline-grid h-5 w-5 place-items-center rounded-full border border-border text-[11px] tabular-nums text-muted-foreground">
                        {n}
                      </span>
                      <span>
                        {t(`steps_${set}_${n}`, { appName: branding.appName })}
                        <span className="text-muted-foreground">
                          {' · '}
                          {t(`steps_${set}_${n}_note`, { appName: branding.appName })}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
            <div className="flex flex-col items-start gap-3">
              {plan === 'team' ? (
                <>
                  <Button asChild size="lg">
                    <a href={CLAUDE_CONNECTORS_HOME} target="_blank" rel="noopener noreferrer">
                      {t('connect_open', { name: targetName('claude') })}
                      <ArrowUpRightIcon className="ml-1.5 h-4 w-4" />
                    </a>
                  </Button>
                  {/* The owner still needs the Add link: only they can put the
                      connector into the organisation in the first place. */}
                  <a
                    href={origin ? claudeConnectorLink({ origin, appName: branding.appName }) : undefined}
                    aria-disabled={!origin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
                  >
                    {t('hero_team_owner_link', { appName: branding.appName })}
                  </a>
                </>
              ) : (
                <>
                  <Button asChild size="lg">
                    <a
                      href={origin ? claudeConnectorLink({ origin, appName: branding.appName }) : undefined}
                      aria-disabled={!origin}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('connect_to_claude')}
                      <ArrowUpRightIcon className="ml-1.5 h-4 w-4" />
                    </a>
                  </Button>
                  <button
                    type="button"
                    onClick={() => openDialog('claude', 'claude_signin')}
                    className="text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
                  >
                    {t('hero_manual')}
                  </button>
                </>
              )}
              {/* The step-by-step guide is canonical on the docs site, in one
                  language per URL. Root-relative so the /docs/api/* 308 in
                  next.config.ts forwards to docs.accounted.se (issue #2133). */}
              <a
                href={locale === 'sv' ? '/docs/api/anslut-claude' : '/docs/api/connect-claude'}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
              >
                {t('full_guide_link')}
                <ArrowUpRightIcon className="h-3 w-3" />
              </a>
            </div>
          </div>
        </SettingsGroup>
      )}
      {keys.length > 0 && (
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
                    {/* A client's name is a word or two and must stay whole; a
                        hand-made key's name can be long and truncates. */}
                    <span className={cn('truncate', kind !== 'key' && 'shrink-0')}>{rowName(key)}</span>
                    {key.mode === 'test' && (
                      <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[11px] font-normal">
                        {t('badge_test')}
                      </Badge>
                    )}
                    {isColleagues(key) && (
                      <Badge
                        variant="secondary"
                        title={key.owner_name ?? undefined}
                        className="max-w-56 shrink truncate px-1.5 py-0 text-[11px] font-normal"
                      >
                        {key.owner_name ? t('badge_colleague_named', { name: key.owner_name }) : t('badge_colleague')}
                      </Badge>
                    )}
                    {/* A service account's key acts as the account, not as
                        the person who sponsors it: marked so it is not read
                        as one of their own connections. */}
                    {key.service_account && (
                      <Badge variant="secondary" className="max-w-48 shrink truncate px-1.5 py-0 text-[11px] font-normal">
                        {t('badge_service_account', { name: key.service_account.name })}
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
                  {/* Only the key's owner may change its companies (the
                      route answers 403 for anyone else), and "2 of 5" is
                      counted against the viewer's companies, so another
                      user's key shows no company control. */}
                  {hasCompanyPicker && key.is_own && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="hidden shrink-0 text-xs font-normal text-muted-foreground md:inline-flex"
                      onClick={() => setEditingCompanies(key)}
                      aria-label={t('companies_edit', { name: rowName(key) })}
                    >
                      <BuildingOfficeIcon className="mr-1.5 h-3.5 w-3.5" />
                      {[
                        key.company_ids && key.company_ids.length > 0
                          ? t('companies_some', { selected: key.company_ids.length, total: companies.length })
                          : t('companies_all'),
                        key.read_only_company_ids && key.read_only_company_ids.length > 0
                          ? t('companies_read_only', { count: key.read_only_company_ids.length })
                          : null,
                      ]
                        .filter((part): part is string => part !== null)
                        .join(' · ')}
                    </Button>
                  )}
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
      )}
      <SettingsGroup label={t(hasOwnConnection ? 'add_connection' : 'something_else')}>
        {tiles(hasOwnConnection ? undefined : 'claude')}
      </SettingsGroup>

      <ConnectClientDialog target={target} origin={origin} initialSet={dialogSet} onClose={() => setTarget(null)} />
      {editingCompanies && (
        <KeyCompaniesDialog
          key={editingCompanies.id}
          keyRow={editingCompanies}
          name={rowName(editingCompanies)}
          companies={companies}
          onClose={() => setEditingCompanies(null)}
          onSaved={() => onKeysChanged?.()}
        />
      )}
      <DestructiveConfirmDialog {...dialogProps} />
    </>
  )
}
