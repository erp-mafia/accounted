'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { SettingsRow, SettingsRowEnd } from '@/components/settings/SettingsRows'
import { CopyBlock } from '@/components/settings/CopyBlock'
import { Plus, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ALL_SCOPES,
  SCOPE_GROUPS,
  STAGING_SCOPES,
  TOOL_COUNT_BY_SCOPE,
  scopeKind,
  type ApiKeyScope,
  type ScopeGroup,
} from '@/lib/auth/scope-catalog'

type Scope = ApiKeyScope

/** i18n key for a scope card: `scope_<domain>_<verb>`. */
const scopeLabelKey = (scope: Scope) => `scope_${scope.replace(':', '_')}`
/** i18n key for a group heading: `group_<domain>`. */
const groupLabelKey = (group: ScopeGroup) => `group_${group.domain}`
/** A group with no MCP tool behind any of its scopes only gates REST endpoints. */
const isRestOnlyGroup = (group: ScopeGroup) =>
  group.scopes.every((scope) => TOOL_COUNT_BY_SCOPE[scope] === 0)


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
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
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

/** The route caps a company at ten live keys (sign-ins count too). */
const MAX_KEYS = 10

/**
 * Settings → API & MCP → Utvecklare: the row that creates an API key, with
 * the scope picker and the one-time key reveal. The keys themselves are
 * listed with every other connection in McpConnectionsPanel.
 */
export function ApiKeysPanel({
  keyCount,
  onCreated,
  borderless,
}: {
  keyCount: number
  onCreated: () => void
  borderless?: boolean
}) {
  const t = useTranslations('settings_api_keys')
  const { toast } = useToast()
  const { dialogProps: sodDialogProps, confirm: confirmSod } = useDestructiveConfirm()

  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
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
      onCreated()
    } catch {
      toast({ title: t('toast_create_failed'), variant: 'destructive' })
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <>
      <SettingsRow
        label={t('title')}
        help={t('description')}
        borderless={borderless}
      >
        <span className="text-xs tabular-nums text-muted-foreground">
          {t('keys_count', { count: keyCount, max: MAX_KEYS })}
        </span>
        <SettingsRowEnd>
          <Button
            variant="outline"
            onClick={() => setShowCreateDialog(true)}
            disabled={keyCount >= MAX_KEYS}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('create_key')}
          </Button>
        </SettingsRowEnd>
      </SettingsRow>

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
            <Button onClick={handleCreate} disabled={newKeyScopes.size === 0} loading={isCreating}>
              {t('create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
