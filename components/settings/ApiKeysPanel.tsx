'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsReveal,
} from '@/components/settings/SettingsRows'
import { AttnLine } from '@/components/ui/attn-line'
import { Loader2, Plus, Copy, Check, Trash2, Key, ChevronDown, AlertTriangle, ArrowUpRight } from 'lucide-react'
import { cn, formatDateLong } from '@/lib/utils'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'
import { getBranding } from '@/lib/branding/service'
import { ILLUSTRATIONS, illustrationSrc } from '@/components/onboarding/onboarding-illustrations'
import {
  ALL_SCOPES,
  SCOPE_GROUPS,
  STAGING_SCOPES,
  TOOL_COUNT_BY_SCOPE,
  scopeKind,
  type ApiKeyScope,
  type ScopeGroup,
} from '@/lib/auth/scope-catalog'

const branding = getBranding()
const connectorName = branding.appName.toLowerCase()

type Scope = ApiKeyScope

/** i18n key for a scope card: `scope_<domain>_<verb>`. */
const scopeLabelKey = (scope: Scope) => `scope_${scope.replace(':', '_')}`
/** i18n key for a group heading: `group_<domain>`. */
const groupLabelKey = (group: ScopeGroup) => `group_${group.domain}`
/** A group with no MCP tool behind any of its scopes only gates REST endpoints. */
const isRestOnlyGroup = (group: ScopeGroup) =>
  group.scopes.every((scope) => TOOL_COUNT_BY_SCOPE[scope] === 0)

interface ApiKey {
  id: string
  key_prefix: string
  name: string
  scopes: string[] | null
  rate_limit_rpm: number
  mode?: 'live' | 'test'
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

type CopyState = 'idle' | 'copied' | 'failed'

function CopyBlock({ text, copyAriaLabel }: { text: string; copyAriaLabel: string }) {
  const t = useTranslations('settings_api_keys')
  const [state, setState] = useState<CopyState>('idle')

  async function handleCopy() {
    // The write is the first await, so the click's user activation still holds.
    const result = await copyToClipboard(text)
    if (result !== 'copied') {
      // Never imply success. The block stays on screen and is select-all, so
      // the user can copy it by hand: with no clipboard there is no other way.
      setState('failed')
      return
    }
    setState('copied')
    setTimeout(() => setState('idle'), 2000)
  }

  return (
    <div className="relative group">
      <pre className="select-all rounded-lg bg-muted p-4 pr-12 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
        {text}
      </pre>
      <Button
        variant="outline"
        size="sm"
        className={cn(
          'absolute right-1.5 top-1.5 h-7 w-7 p-0 transition-opacity focus-visible:opacity-100',
          state === 'failed' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onClick={handleCopy}
        aria-label={copyAriaLabel}
      >
        {state === 'copied' ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : state === 'failed' ? (
          <AlertTriangle className="h-3.5 w-3.5 text-attn" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
      {/* Live region is always mounted so the message is announced when it
          appears, not merely inserted. */}
      <div role="status" aria-live="polite">
        {state === 'failed' && <AttnLine className="mt-1.5">{t('copy_failed')}</AttnLine>}
      </div>
    </div>
  )
}

function ScopeCard({
  scope,
  checked,
  onCheckedChange,
}: {
  scope: Scope
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const t = useTranslations('settings_api_keys')
  const label = t(scopeLabelKey(scope))
  const tools = TOOL_COUNT_BY_SCOPE[scope]
  const sepIdx = label.indexOf(': ')
  const verb = sepIdx > 0 ? label.slice(0, sepIdx) : label
  const description = sepIdx > 0 ? label.slice(sepIdx + 2) : ''

  return (
    <label
      className={cn(
        'flex min-h-[68px] cursor-pointer flex-col gap-1 rounded-lg border p-2 transition-colors',
        checked
          ? 'border-border bg-secondary'
          : 'border-border hover:bg-secondary/60'
      )}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checked}
          onCheckedChange={onCheckedChange}
          className="shrink-0"
        />
        <span className="flex-1 text-xs font-medium text-foreground">{verb}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {tools > 0 ? t('tools_count', { count: tools }) : t('rest_badge')}
        </span>
      </div>
      {description && (
        <p className="ml-6 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      )}
    </label>
  )
}

export function ApiKeysPanel() {
  const t = useTranslations('settings_api_keys')
  const locale = useLocale()
  const { toast } = useToast()
  const { dialogProps: revokeDialogProps, confirm: confirmRevoke } = useDestructiveConfirm()
  const { dialogProps: sodDialogProps, confirm: confirmSod } = useDestructiveConfirm()

  const [keys, setKeys] = useState<ApiKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [showApiKeyMethods, setShowApiKeyMethods] = useState(false)
  const [showOtherClients, setShowOtherClients] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  // 'live' by default: this is the general MCP-key surface and the dominant case
  // is a key for the user's real company. 'test' is an explicit opt-in: a
  // simulation-only key that forces dry-run on every write (nothing is saved).
  const [newKeyMode, setNewKeyMode] = useState<'live' | 'test'>('live')
  const [newKeyScopes, setNewKeyScopes] = useState<Set<Scope>>(new Set(ALL_SCOPES))
  const [newKeyValue, setNewKeyValue] = useState('')

  // Segregation-of-duties: a single key that both stages bookkeeping (any
  // STAGING_SCOPES member) AND can approve it (pending_operations:approve)
  // lets an automated agent commit financial postings with no human in the
  // loop. We warn inline and require an explicit confirm before submitting
  // with acknowledge_sod: the route returns 409 API_KEY_SOD_CONFLICT
  // otherwise (default create ticks all scopes, so this path is the norm).
  const sodConflictScope = STAGING_SCOPES.find((s) => newKeyScopes.has(s)) ?? null
  const hasSodConflict =
    newKeyScopes.has('pending_operations:approve') && sodConflictScope !== null

  // Elevated scopes (write/approve/signoff) imply the group's read scope:
  // ticking one ticks read, and unticking read clears the whole group.
  function toggleScope(group: ScopeGroup, scope: Scope, checked: boolean) {
    setNewKeyScopes((prev) => {
      const next = new Set(prev)
      const readScope = group.scopes.find((s) => scopeKind(s) === 'read')
      if (checked) {
        next.add(scope)
        if (readScope) next.add(readScope)
      } else if (scope === readScope) {
        for (const s of group.scopes) next.delete(s)
      } else {
        next.delete(scope)
      }
      return next
    })
  }

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/api-keys')
      const json = await res.json()
      if (json.data) {
        setKeys(json.data.filter((k: ApiKey) => !k.revoked_at))
      }
    } catch {
      toast({ title: t('toast_fetch_failed'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast, t])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  async function handleCreate() {
    // SoD: require an explicit, auditable acknowledgement before minting a key
    // that can both stage and approve postings.
    if (hasSodConflict) {
      const ok = await confirmSod({
        title: t('sod_dialog_title'),
        description: t('sod_dialog_description'),
        confirmLabel: t('sod_confirm'),
        variant: 'warning',
      })
      if (!ok) return
    }

    setIsCreating(true)
    try {
      const res = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyName || t('default_key_name'),
          scopes: Array.from(newKeyScopes),
          mode: newKeyMode,
          ...(hasSodConflict ? { acknowledge_sod: true } : {}),
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        // The route returns the canonical { error: { code, message, message_en } }
        // envelope: render the message string, never the object (a React child
        // must be a string, not { code, message, ... }).
        const message =
          typeof json.error === 'string'
            ? json.error
            : json.error?.message ?? t('toast_create_failed')
        toast({ title: message, variant: 'destructive' })
        return
      }

      setNewKeyValue(json.data.key)
      setShowCreateDialog(false)
      setShowKeyDialog(true)
      setNewKeyName('')
      setNewKeyMode('live')
      setNewKeyScopes(new Set(ALL_SCOPES))
      fetchKeys()
    } catch {
      toast({ title: t('toast_create_failed'), variant: 'destructive' })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRevoke(id: string, name: string) {
    const ok = await confirmRevoke({
      title: t('revoke_dialog_title'),
      description: t('revoke_dialog_description', { name }),
      confirmLabel: t('revoke_confirm'),
    })
    if (!ok) return

    try {
      await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
      setKeys((prev) => prev.filter((k) => k.id !== id))
      toast({ title: t('toast_revoked') })
    } catch {
      toast({ title: t('toast_revoke_failed'), variant: 'destructive' })
    }
  }

  // This panel is server-rendered before it hydrates, and window.location has
  // no server equivalent. Reading the origin at render time therefore yields a
  // relative URL in the first paint, and a click on the install link in that
  // window would hand claude.ai a connectorUrl it cannot resolve. Resolve the
  // origin after mount and withhold the link's href until it is known.
  const [origin, setOrigin] = useState('')
  useEffect(() => setOrigin(window.location.origin), [])
  const mcpBase = `${origin}/api/extensions/ext/mcp-server/mcp`
  // `tool_namespace=accounted` is load-bearing: resolveMcpToolNamespace()
  // falls back to the legacy `gnubok_` tool prefix when the param is absent,
  // so a URL without it hands the client tool names that none of our docs,
  // skills, or the Claude Code plugin reference. `client` is a telemetry-only
  // distribution marker (server reads it; never used for auth).
  const mcpUrl = (client: string) =>
    `${mcpBase}?tool_namespace=accounted&client=${client}`
  // claude.ai's Add-custom-connector dialog probes the URL without credentials
  // and pre-fills Authentication "None" when the lazy handshake answers 200,
  // which blocks the sign-in later. `auth=required` makes every tokenless
  // request answer the 401 challenge so the dialog detects OAuth instead
  // (extensions/general/mcp-server/auth-mode.ts). Claude Code, Cursor and the
  // stdio bridge keep the lazy URL.
  const claudeConnectorUrl = `${mcpUrl('claude-connector')}&auth=required`

  // claude.ai install link: opens Add-custom-connector with name and URL
  // prefilled. It only prefills the dialog, so the user still reviews and
  // confirms, and Anthropic's cloud must be able to reach the URL: on
  // localhost or a firewalled self-host the manual paste below is the path.
  // https://claude.com/docs/connectors/building/directory-vs-custom
  const claudeInstallUrl =
    'https://claude.ai/customize/connectors?modal=add-custom-connector' +
    `&connectorName=${encodeURIComponent(branding.appName)}` +
    `&connectorUrl=${encodeURIComponent(claudeConnectorUrl)}`

  return (
    <>
      <SettingsGroup label={t('connect_mcp_title')}>
        {/* The marketing site's halftone AI marks (Claude, OpenAI): a quiet
            "works with" cue, not chrome. Text carries the meaning; the marks
            are decorative. */}
        <div className="flex items-center gap-3 px-1 pb-1 pt-3">
          <div aria-hidden className="flex shrink-0 items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={illustrationSrc('logo-claude')}
              width={ILLUSTRATIONS['logo-claude'].w}
              height={ILLUSTRATIONS['logo-claude'].h}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-5 w-auto"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={illustrationSrc('logo-openai')}
              width={ILLUSTRATIONS['logo-openai'].w}
              height={ILLUSTRATIONS['logo-openai'].h}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-5 w-auto"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('works_with_ai')}</p>
        </div>
        {/* claude.ai is the path for nearly everyone, and the install link
            makes it one click, so it is the only thing above the fold. Every
            other client needs a config file or a terminal, which is a
            different job: it lives behind one disclosure instead of four
            code blocks competing with the button. */}
        <div className="px-1 pb-4 pt-2">
          <Button asChild size="lg">
            <a
              href={origin ? claudeInstallUrl : undefined}
              aria-disabled={!origin}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('connect_to_claude')}
              <ArrowUpRight className="ml-1.5 h-4 w-4" />
            </a>
          </Button>
          <p className="mt-2 max-w-prose text-xs text-muted-foreground">
            {t('connect_to_claude_help')}
          </p>
          {/* The step-by-step guide is canonical on the docs site, in one
              language per URL (the docs site has no locale routing). Root-relative
              so the /docs/api/* 308 in next.config.ts forwards to docs.gnubok.se.
              It sits right under the button: the steps on Claude's side after
              the click (consent, first-call sign-in) live there, and a reader
              who has just clicked should not have to open two disclosures to
              find them (issue #2133). */}
          <a
            href={locale === 'sv' ? '/docs/api/anslut-claude' : '/docs/api/connect-claude'}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
          >
            {t('full_guide_link')}
            <ArrowUpRight className="h-3 w-3" />
          </a>
        </div>

        <button
          type="button"
          aria-expanded={showOtherClients}
          onClick={() => setShowOtherClients(!showOtherClients)}
          className="flex w-full items-center gap-2 border-t border-border px-1 py-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform duration-150',
              !showOtherClients && '-rotate-90',
            )}
          />
          {t('other_clients')}
        </button>
        <SettingsReveal open={showOtherClients}>
          <div className="space-y-6 pb-3 pt-1">
            <div>
              <p className="mb-1 text-sm">{t('claude_ai_manual')}</p>
              <p className="mb-2 text-xs text-muted-foreground">
                {t.rich('claude_ai_instructions', {
                  // Prose gets the brand's real casing; `connectorName` is the
                  // lowercased config key and reads wrong in a sentence.
                  connectorName: branding.appName,
                  path: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <CopyBlock text={claudeConnectorUrl} copyAriaLabel={t('copy_aria')} />
            </div>

            <div>
              <p className="mb-1 text-sm">Grok</p>
              <p className="mb-2 text-xs text-muted-foreground">
                {t.rich('grok_instructions', {
                  path: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
              <CopyBlock text={mcpUrl('grok')} copyAriaLabel={t('copy_aria')} />
            </div>

            <div>
              <p className="mb-1 text-sm">{t('claude_plugin_label')}</p>
              <p className="mb-2 text-xs text-muted-foreground">{t('claude_plugin_instructions')}</p>
              <CopyBlock
                text={`/plugin marketplace add erp-mafia/accounted\n/plugin install accounted@accounted`}
                copyAriaLabel={t('copy_aria')}
              />
            </div>

            <div>
              <p className="mb-1 text-sm">Claude Code</p>
              <p className="mb-2 text-xs text-muted-foreground">{t('terminal_runs_browser_login')}</p>
              {/* URL is quoted: unquoted `?` in the query string trips zsh globbing. */}
              <CopyBlock text={`claude mcp add --transport http ${connectorName} "${mcpUrl('claude-code')}"`} copyAriaLabel={t('copy_aria')} />
            </div>

            <div>
              <p className="mb-1 text-sm">Cursor</p>
              <p className="mb-2 text-xs text-muted-foreground">
                {t.rich('cursor_instructions', {
                  code: (chunks) => <code className="text-xs">{chunks}</code>,
                })}
              </p>
              <CopyBlock text={`{
  "mcpServers": {
    "${connectorName}": {
      "url": "${mcpUrl('cursor')}"
    }
  }
}`} copyAriaLabel={t('copy_aria')} />
            </div>
          </div>
        </SettingsReveal>

        <button
          type="button"
          aria-expanded={showApiKeyMethods}
          onClick={() => setShowApiKeyMethods(!showApiKeyMethods)}
          className="flex w-full items-center gap-2 border-t border-border px-1 py-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform duration-150',
              !showApiKeyMethods && '-rotate-90',
            )}
          />
          {t('connect_with_api_key')}
        </button>
        <SettingsReveal open={showApiKeyMethods}>
          <div className="space-y-6 pb-3 pt-1">
            <div>
              <p className="mb-1 text-sm">Claude Desktop</p>
              <p className="mb-2 text-xs text-muted-foreground">
                {t.rich('claude_desktop_instructions', {
                  code: (chunks) => <code className="text-xs">{chunks}</code>,
                })}
              </p>
              {/* ACCOUNTED_URL is emitted so self-hosted and white-label
                  instances get a config that points at their own host: the
                  bridge otherwise defaults to the hosted endpoint. The key
                  value keeps the `gnubok_sk_` wire prefix on purpose. */}
              <CopyBlock text={`{
  "mcpServers": {
    "${connectorName}": {
      "command": "npx",
      "args": ["-y", "accounted-mcp"],
      "env": {
        "ACCOUNTED_API_KEY": "gnubok_sk_...",
        "ACCOUNTED_URL": "${mcpUrl('claude-desktop')}",
        "ACCOUNTED_CLIENT": "claude-desktop"
      }
    }
  }
}`} copyAriaLabel={t('copy_aria')} />
            </div>

            <div>
              <p className="mb-1 text-sm">Claude Code</p>
              <p className="mb-2 text-xs text-muted-foreground">
                {t('terminal_with_api_key')}
              </p>
              <CopyBlock text={`claude mcp add --transport http ${connectorName} \\
  "${mcpUrl('claude-code')}" \\
  --header "Authorization: Bearer gnubok_sk_..."`} copyAriaLabel={t('copy_aria')} />
            </div>
          </div>
        </SettingsReveal>
      </SettingsGroup>

      <SettingsGroup>
        {/* Group eyebrow with the group's primary action on the right. Styling
            mirrors SettingsGroup's label line; the "?" holds the old panel
            description. */}
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>{t('title')}</span>
            <HelpPopover className="shrink-0">{t('description')}</HelpPopover>
          </p>
          <Button
            size="sm"
            onClick={() => setShowCreateDialog(true)}
            disabled={keys.length >= 10}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('create_key')}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            icon={Key}
            title={t('empty_title')}
            description={t('empty_help')}
          />
        ) : (
          keys.map((key) => {
            const scopeCount = key.scopes?.length ?? 0
            const permissionSummary =
              scopeCount === ALL_SCOPES.length
                ? t('all_permissions')
                : scopeCount === 0
                  ? t('no_permissions')
                  : t('permissions_count', { count: scopeCount })
            return (
              <div
                key={key.id}
                className="flex items-center gap-3 border-b border-border px-1 py-3"
              >
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm">{key.name}</span>
                    {key.mode === 'test' && (
                      <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
                        {t('badge_test')}
                      </Badge>
                    )}
                  </span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {permissionSummary}
                    {' · '}
                    <span className="font-mono">{key.key_prefix}...</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t('created')} {formatDateLong(key.created_at, locale)}
                    {' · '}
                    {key.last_used_at
                      ? t('used_on', { date: formatDateLong(key.last_used_at, locale) })
                      : t('never_used')}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRevoke(key.id, key.name)}
                  aria-label={t('revoke_aria', { name: key.name })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          })
        )}
      </SettingsGroup>

      {/* Create key dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-[calc(100vw-2rem)] rounded-xl p-4 sm:max-w-3xl sm:p-6">
          <DialogHeader>
            <DialogTitle>{t('create_dialog_title')}</DialogTitle>
            <DialogDescription>
              {t('create_dialog_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="key-name">{t('name_label')}</Label>
              <Input
                id="key-name"
                placeholder={t('name_placeholder')}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('mode_label')}</Label>
              <div className="inline-flex rounded-full border p-0.5" role="radiogroup" aria-label={t('mode_label')}>
                {(['live', 'test'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={newKeyMode === m}
                    onClick={() => setNewKeyMode(m)}
                    className={cn(
                      'rounded-full px-3 py-1.5 text-xs transition-colors',
                      newKeyMode === m
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t(m === 'live' ? 'mode_live' : 'mode_test')}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {newKeyMode === 'test' ? t('mode_test_help') : t('mode_live_help')}
              </p>
            </div>
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="space-y-1">
                  <Label>{t('permissions_label')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('permissions_help')}
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('selected_count', { selected: newKeyScopes.size, total: ALL_SCOPES.length })}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.domain} className="space-y-2">
                    <h4 className="text-sm font-medium">
                      {isRestOnlyGroup(group)
                        ? t('group_rest_only', { name: t(groupLabelKey(group)) })
                        : t(groupLabelKey(group))}
                    </h4>
                    <div className="space-y-2 px-2">
                      {group.scopes.map((scope) => (
                        <ScopeCard
                          key={scope}
                          scope={scope}
                          checked={newKeyScopes.has(scope)}
                          onCheckedChange={(checked) => toggleScope(group, scope, checked)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {hasSodConflict && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-foreground"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <p className="leading-snug">{t('sod_warning')}</p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || newKeyScopes.size === 0}>
              {isCreating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...revokeDialogProps} />
      <DestructiveConfirmDialog {...sodDialogProps} />

      {/* Show key once dialog */}
      <Dialog open={showKeyDialog} onOpenChange={(open) => {
        if (!open) {
          setNewKeyValue('')
        }
        setShowKeyDialog(open)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('new_key_dialog_title')}</DialogTitle>
            <DialogDescription>
              {t('new_key_dialog_description')}
            </DialogDescription>
          </DialogHeader>
          <CopyBlock text={newKeyValue} copyAriaLabel={t('copy_aria')} />
          <DialogFooter>
            <Button onClick={() => {
              setShowKeyDialog(false)
              setNewKeyValue('')
            }}>
              {t('done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
