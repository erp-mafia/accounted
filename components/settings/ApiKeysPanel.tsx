'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Plus, Copy, Check, Trash2, Key, ChevronDown, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBranding } from '@/lib/branding/service'
import { STAGING_SCOPES } from '@/lib/auth/api-keys'
import type { ApiKeyScope } from '@/lib/auth/api-keys'

const branding = getBranding()
const connectorName = branding.appName.toLowerCase()

type ScopeEntry = {
  scope: ApiKeyScope
  labelKey: string
  /** Number of MCP tools gated by this scope. 0 = REST-API-only scope. */
  tools: number
}

type ScopeGroup = {
  domain: string
  labelKey: string
  read: ScopeEntry | null
  write: ScopeEntry | null
}

const SCOPE_GROUPS: ScopeGroup[] = [
  {
    domain: 'transactions',
    labelKey: 'group_transactions',
    read: { scope: 'transactions:read', labelKey: 'scope_transactions_read', tools: 8 },
    write: { scope: 'transactions:write', labelKey: 'scope_transactions_write', tools: 8 },
  },
  {
    domain: 'customers',
    labelKey: 'group_customers',
    read: { scope: 'customers:read', labelKey: 'scope_customers_read', tools: 1 },
    write: { scope: 'customers:write', labelKey: 'scope_customers_write', tools: 1 },
  },
  {
    domain: 'invoices',
    labelKey: 'group_invoices',
    read: { scope: 'invoices:read', labelKey: 'scope_invoices_read', tools: 1 },
    write: { scope: 'invoices:write', labelKey: 'scope_invoices_write', tools: 6 },
  },
  {
    domain: 'suppliers',
    labelKey: 'group_suppliers',
    read: { scope: 'suppliers:read', labelKey: 'scope_suppliers_read', tools: 2 },
    write: { scope: 'suppliers:write', labelKey: 'scope_suppliers_write', tools: 3 },
  },
  {
    domain: 'reports',
    labelKey: 'group_reports',
    read: { scope: 'reports:read', labelKey: 'scope_reports_read', tools: 18 },
    write: null,
  },
  {
    domain: 'bookkeeping',
    labelKey: 'group_bookkeeping',
    read: null,
    write: { scope: 'bookkeeping:write', labelKey: 'scope_bookkeeping_write', tools: 11 },
  },
  {
    domain: 'payroll',
    labelKey: 'group_payroll',
    read: { scope: 'payroll:read', labelKey: 'scope_payroll_read', tools: 3 },
    write: { scope: 'payroll:write', labelKey: 'scope_payroll_write', tools: 3 },
  },
  {
    domain: 'pending_operations',
    labelKey: 'group_pending_operations',
    read: { scope: 'pending_operations:read', labelKey: 'scope_pending_operations_read', tools: 1 },
    write: { scope: 'pending_operations:approve', labelKey: 'scope_pending_operations_approve', tools: 2 },
  },
  {
    domain: 'agent',
    labelKey: 'group_agent',
    read: { scope: 'agent:read', labelKey: 'scope_agent_read', tools: 1 },
    write: { scope: 'agent:write', labelKey: 'scope_agent_write', tools: 2 },
  },
  {
    domain: 'documents',
    labelKey: 'group_documents',
    read: { scope: 'documents:read', labelKey: 'scope_documents_read', tools: 0 },
    write: { scope: 'documents:write', labelKey: 'scope_documents_write', tools: 0 },
  },
  {
    domain: 'companies',
    labelKey: 'group_companies',
    read: { scope: 'companies:read', labelKey: 'scope_companies_read', tools: 0 },
    write: null,
  },
  {
    domain: 'events',
    labelKey: 'group_events',
    read: { scope: 'events:read', labelKey: 'scope_events_read', tools: 0 },
    write: null,
  },
  {
    domain: 'webhooks',
    labelKey: 'group_webhooks',
    read: null,
    write: { scope: 'webhooks:manage', labelKey: 'scope_webhooks_manage', tools: 0 },
  },
  {
    domain: 'operations',
    labelKey: 'group_operations',
    read: { scope: 'operations:read', labelKey: 'scope_operations_read', tools: 0 },
    write: null,
  },
  {
    domain: 'compliance',
    labelKey: 'group_compliance',
    read: { scope: 'compliance:read', labelKey: 'scope_compliance_read', tools: 3 },
    write: null,
  },
  {
    domain: 'skatteverket',
    labelKey: 'group_skatteverket',
    read: null,
    write: { scope: 'skatteverket:write', labelKey: 'scope_skatteverket_write', tools: 2 },
  },
]

type Scope = ApiKeyScope

const ALL_SCOPES: Scope[] = SCOPE_GROUPS.flatMap((g) => {
  const out: Scope[] = []
  if (g.read) out.push(g.read.scope)
  if (g.write) out.push(g.write.scope)
  return out
})

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

function CopyBlock({ text, copyAriaLabel }: { text: string; copyAriaLabel: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (insecure context) — silently ignore
    }
  }

  return (
    <div className="relative group">
      <pre className="rounded-md bg-muted p-4 pr-12 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-1.5 top-1.5 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
        aria-label={copyAriaLabel}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  )
}

function ScopeCard({
  entry,
  checked,
  onCheckedChange,
}: {
  entry: ScopeEntry
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const t = useTranslations('settings_api_keys')
  const label = t(entry.labelKey)
  const dashIdx = label.indexOf(' — ')
  const verb = dashIdx > 0 ? label.slice(0, dashIdx) : label
  const description = dashIdx > 0 ? label.slice(dashIdx + 3) : ''

  return (
    <label
      className={cn(
        'flex min-h-[68px] cursor-pointer flex-col gap-1 rounded-md border p-2 transition-colors',
        checked
          ? 'border-foreground/30 bg-secondary'
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
          {entry.tools > 0 ? t('tools_count', { count: entry.tools }) : t('rest_badge')}
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
  const { toast } = useToast()
  const { dialogProps: revokeDialogProps, confirm: confirmRevoke } = useDestructiveConfirm()
  const { dialogProps: sodDialogProps, confirm: confirmSod } = useDestructiveConfirm()

  const [keys, setKeys] = useState<ApiKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [showApiKeyMethods, setShowApiKeyMethods] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  // 'live' by default: this is the general MCP-key surface and the dominant case
  // is a key for the user's real company. 'test' is an explicit opt-in — a
  // simulation-only key that forces dry-run on every write (nothing is saved).
  const [newKeyMode, setNewKeyMode] = useState<'live' | 'test'>('live')
  const [newKeyScopes, setNewKeyScopes] = useState<Set<Scope>>(new Set(ALL_SCOPES))
  const [newKeyValue, setNewKeyValue] = useState('')
  const [copied, setCopied] = useState(false)

  // Segregation-of-duties: a single key that both stages bookkeeping (any
  // STAGING_SCOPES member) AND can approve it (pending_operations:approve)
  // lets an automated agent commit financial postings with no human in the
  // loop. We warn inline and require an explicit confirm before submitting
  // with acknowledge_sod — the route returns 409 API_KEY_SOD_CONFLICT
  // otherwise (default create ticks all scopes, so this path is the norm).
  const sodConflictScope = STAGING_SCOPES.find((s) => newKeyScopes.has(s)) ?? null
  const hasSodConflict =
    newKeyScopes.has('pending_operations:approve') && sodConflictScope !== null

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
        // envelope — render the message string, never the object (a React child
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

  function handleCopy() {
    navigator.clipboard.writeText(newKeyValue)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function formatDate(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const mcpBase = typeof window !== 'undefined'
    ? `${window.location.origin}/api/extensions/ext/mcp-server/mcp`
    : '/api/extensions/ext/mcp-server/mcp'
  // Telemetry-only distribution-channel marker (server reads the `client` query
  // param; never used for auth). Lets us measure which Claude surface connected.
  const mcpUrl = (client: string) => `${mcpBase}?client=${client}`

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('title')}</CardTitle>
              <CardDescription>
                {t('description')}
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setShowCreateDialog(true)}
              disabled={keys.length >= 10}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('create_key')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Key className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">{t('empty_title')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('empty_help')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {keys.map((key) => {
                const scopeCount = key.scopes?.length ?? 0
                return (
                  <div
                    key={key.id}
                    className="flex items-center justify-between rounded-md border px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{key.name}</p>
                        {key.mode === 'test' && (
                          <Badge variant="secondary" className="shrink-0 text-[10px] font-normal px-1.5 py-0">
                            {t('badge_test')}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {scopeCount === ALL_SCOPES.length
                            ? t('all_permissions')
                            : scopeCount === 0
                              ? t('no_permissions')
                              : t('permissions_count', { count: scopeCount })}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <code className="text-xs text-muted-foreground font-mono">
                          {key.key_prefix}...
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {t('created')} {formatDate(key.created_at)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {key.last_used_at
                            ? t('used_on', { date: formatDate(key.last_used_at) })
                            : t('never_used')}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(key.id, key.name)}
                      aria-label={t('revoke_aria', { name: key.name })}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('connect_mcp_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-sm font-medium">Claude.ai</p>
              <Badge variant="secondary" className="text-[10px] font-normal px-1.5 py-0">{t('recommended_badge')}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {t.rich('claude_ai_instructions', {
                connectorName,
                path: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
            <CopyBlock text={mcpUrl('claude-connector')} copyAriaLabel={t('copy_aria')} />
          </div>

          <div>
            <p className="text-sm font-medium mb-2">{t('claude_code_cursor')}</p>
            <p className="text-xs text-muted-foreground mb-2">
              {t('terminal_runs_browser_login')}
            </p>
            {/* URL is quoted — unquoted `?` in the query string trips zsh globbing. */}
            <CopyBlock text={`claude mcp add ${connectorName} --transport http "${mcpUrl('claude-code')}"`} copyAriaLabel={t('copy_aria')} />
          </div>

          <div className="border-t pt-4">
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowApiKeyMethods(!showApiKeyMethods)}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showApiKeyMethods ? '' : '-rotate-90'}`} />
              {t('connect_with_api_key')}
            </button>
            {showApiKeyMethods && (
              <div className="space-y-6 pt-4 animate-in slide-in-from-top-1 duration-150">
                <div>
                  <p className="text-sm font-medium mb-1">Claude Desktop</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    {t.rich('claude_desktop_instructions', {
                      code: (chunks) => <code className="text-xs">{chunks}</code>,
                    })}
                  </p>
                  <CopyBlock text={`{
  "mcpServers": {
    "${connectorName}": {
      "command": "npx",
      "args": ["gnubok-mcp"],
      "env": {
        "GNUBOK_API_KEY": "gnubok_sk_...",
        "GNUBOK_CLIENT": "claude-desktop"
      }
    }
  }
}`} copyAriaLabel={t('copy_aria')} />
                </div>

                <div>
                  <p className="text-sm font-medium mb-1">{t('claude_code_cursor')}</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    {t('terminal_with_api_key')}
                  </p>
                  <CopyBlock text={`claude mcp add ${connectorName} --transport http \\
  --url "${mcpUrl('claude-code')}" \\
  --header "Authorization: Bearer gnubok_sk_..."`} copyAriaLabel={t('copy_aria')} />
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Create key dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-[calc(100vw-2rem)] rounded-2xl p-4 sm:max-w-3xl sm:p-6">
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
              <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label={t('mode_label')}>
                {(['live', 'test'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={newKeyMode === m}
                    onClick={() => setNewKeyMode(m)}
                    className={cn(
                      'rounded-[5px] px-3 py-1.5 text-xs transition-colors',
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
                    <h4 className="text-sm font-medium">{t(group.labelKey)}</h4>
                    <div className="space-y-2 px-2">
                      {group.read && (
                        <ScopeCard
                          entry={group.read}
                          checked={newKeyScopes.has(group.read.scope)}
                          onCheckedChange={(checked) => {
                            setNewKeyScopes((prev) => {
                              const next = new Set(prev)
                              if (checked) {
                                next.add(group.read!.scope)
                              } else {
                                next.delete(group.read!.scope)
                                if (group.write) next.delete(group.write.scope)
                              }
                              return next
                            })
                          }}
                        />
                      )}
                      {group.write && (
                        <ScopeCard
                          entry={group.write}
                          checked={newKeyScopes.has(group.write.scope)}
                          onCheckedChange={(checked) => {
                            setNewKeyScopes((prev) => {
                              const next = new Set(prev)
                              if (checked) {
                                next.add(group.write!.scope)
                                if (group.read) next.add(group.read.scope)
                              } else {
                                next.delete(group.write!.scope)
                              }
                              return next
                            })
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {hasSodConflict && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-foreground"
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
          setCopied(false)
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
          <div className="relative">
            <code className="block rounded-md bg-muted p-4 pr-12 text-sm font-mono break-all">
              {newKeyValue}
            </code>
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-2 top-2"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setShowKeyDialog(false)
              setNewKeyValue('')
              setCopied(false)
            }}>
              {t('done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
