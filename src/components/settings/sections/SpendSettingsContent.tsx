'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import {
  SettingsBackLink,
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { useSpendHealthText } from '@/components/spend/reason-text'
import type { SpendConnectionJson, SpendProviderJson, SpendSettingsJson } from '@/components/spend/types'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isAccountNumber } from '@/lib/invariants'
import { isWalletAccount } from '@/lib/spend/settings'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useAccounts } from '@/lib/reference-data/hooks'
import { formatDate } from '@/lib/utils'

/** A code from the return route's ?spend_error=, never free text from the URL. */
const RETURN_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/

/**
 * Kopplingar -> Kortköp: connect a company card or spend platform (Pleo
 * first) through Accounted Connect, see whether its expenses arrive, and
 * choose the accounts they book against. The provider's consent page sends
 * the browser back through /api/spend/connections/return, which lands here
 * with ?spend_connected=1 or ?spend_error=CODE.
 */
export function SpendSettingsContent() {
  const t = useTranslations('spend')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const errorLocale = useLocale() as ErrorLocale
  const searchParams = useSearchParams()
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const healthText = useSpendHealthText()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [connections, setConnections] = useState<SpendConnectionJson[] | null>(null)
  const [available, setAvailable] = useState(true)
  const [providers, setProviders] = useState<SpendProviderJson[] | null>(null)
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [keyFor, setKeyFor] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/spend/connections')
      const json = (await res.json()) as { data?: { connections: SpendConnectionJson[]; available: boolean } }
      setConnections(json.data?.connections ?? [])
      setAvailable(json.data?.available ?? false)
      if (!json.data?.available) return
      const providersRes = await fetch('/api/spend/providers')
      const providersJson = await providersRes.json()
      if (!providersRes.ok) {
        setProviders(null)
        setProvidersError(getErrorMessage(providersJson, { statusCode: providersRes.status, locale: errorLocale }))
        return
      }
      setProvidersError(null)
      setProviders((providersJson.data?.providers ?? []) as SpendProviderJson[])
    } catch {
      setConnections((current) => current ?? [])
      setProvidersError(t('providers_failed'))
    }
  }, [errorLocale, t])

  useEffect(() => {
    void load()
  }, [load])

  // Back from the provider's consent page.
  useEffect(() => {
    const connected = searchParams.get('spend_connected')
    const error = searchParams.get('spend_error')
    if (connected === '1') {
      toast({ title: t('connected_toast'), description: t('connected_toast_description') })
      router.replace('/settings/spend')
    } else if (error) {
      const code = RETURN_ERROR_CODE.test(error) ? error : 'SPEND_CONNECT_FAILED'
      toast({ title: t('connect_failed'), description: getErrorMessage({ error: { code } }, { locale: errorLocale }), variant: 'destructive' })
      router.replace('/settings/spend')
    }
  }, [searchParams, router, toast, t, errorLocale])

  const active = (connections ?? []).filter((c) => c.status === 'active')
  const ended = (connections ?? []).filter((c) => c.status === 'disconnected')
  const connectable = (providers ?? []).filter((p) => !active.some((c) => c.provider === p.ref))

  async function connect(provider: SpendProviderJson) {
    setConnecting(provider.ref)
    try {
      const res = await fetch('/api/spend/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider.ref }),
      })
      const json = await res.json()
      const authorizeUrl = json.data?.authorize_url as string | undefined
      if (!res.ok || json.error || !authorizeUrl) {
        toast({ title: t('connect_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        setConnecting(null)
        return
      }
      // The provider's consent page; the return route brings the browser back here.
      window.location.assign(authorizeUrl)
    } catch {
      toast({ title: t('connect_failed'), variant: 'destructive' })
      setConnecting(null)
    }
  }

  async function connectWithKey(provider: SpendProviderJson) {
    setConnecting(provider.ref)
    try {
      const res = await fetch('/api/spend/connections/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider.ref, api_key: apiKey.trim() }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('connect_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      setApiKey('')
      setKeyFor(null)
      toast({ title: t('connected_toast'), description: t('connected_toast_description') })
      void load()
    } catch {
      toast({ title: t('connect_failed'), variant: 'destructive' })
    } finally {
      setConnecting(null)
    }
  }

  async function disconnect(connection: SpendConnectionJson) {
    await confirm(
      {
        title: t('disconnect_title', { provider: connection.provider_name }),
        description: t('disconnect_description'),
        confirmLabel: t('disconnect_confirm'),
      },
      async () => {
        const res = await fetch(`/api/spend/connections/${connection.id}/disconnect`, { method: 'POST' })
        const json = await res.json()
        if (!res.ok || json.error) {
          toast({ title: t('disconnect_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
          throw new Error('disconnect failed')
        }
        void load()
      },
    )
  }

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      <SettingsSectionHeader title={tNav('spend')} intro={tIntro('spend')} />

      {connections === null ? (
        <div className="space-y-2 pt-8">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : !available ? (
        <SettingsGroup>
          <SettingsRow label={t('unavailable_label')}>
            <SettingsRowNote>{t('unavailable')}</SettingsRowNote>
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <>
          {active.map((connection) => (
            <ConnectionSettings
              key={connection.id}
              connection={connection}
              canWrite={canWrite}
              healthText={healthText}
              onDisconnect={() => void disconnect(connection)}
              onSaved={() => void load()}
            />
          ))}

          {connectable.length > 0 || active.length === 0 ? (
            <SettingsGroup label={t('group_available')} help={t('group_available_help')}>
              {providersError ? (
                <SettingsRow label={t('providers_label')}>
                  <SettingsRowNote>{providersError}</SettingsRowNote>
                  <SettingsRowEnd>
                    <Button variant="outline" onClick={() => void load()}>
                      {t('retry')}
                    </Button>
                  </SettingsRowEnd>
                </SettingsRow>
              ) : connectable.length === 0 ? (
                <SettingsRow label={t('providers_label')}>
                  <SettingsRowNote>{t('no_providers')}</SettingsRowNote>
                </SettingsRow>
              ) : (
                connectable.map((provider) => {
                  const oauth = provider.connectModes.includes('oauth')
                  const withKey = provider.connectModes.includes('api_key')
                  const keyOpen = keyFor === provider.ref
                  return (
                    <div key={provider.ref}>
                      <SettingsRow label={provider.displayName} help={provider.setupNoteSv ?? undefined} borderless={keyOpen}>
                        <SettingsRowEnd>
                          {withKey ? (
                            <Button variant="ghost" disabled={!canWrite} onClick={() => setKeyFor(keyOpen ? null : provider.ref)}>
                              {t('connect_key_toggle')}
                            </Button>
                          ) : null}
                          {oauth ? (
                            <Button
                              variant="outline"
                             
                              disabled={!canWrite || connecting !== null}
                              loading={connecting === provider.ref && !keyOpen}
                              onClick={() => void connect(provider)}
                            >
                              {t('connect_button')}
                            </Button>
                          ) : null}
                        </SettingsRowEnd>
                      </SettingsRow>
                      {withKey ? (
                        <SettingsReveal open={keyOpen}>
                          <SettingsRow label={t('api_key_label')} htmlFor={`spend-key-${provider.ref}`} help={t('api_key_help')} align="baseline">
                            <SettingsInput
                              id={`spend-key-${provider.ref}`}
                              type="password"
                              autoComplete="off"
                              value={apiKey}
                              onChange={(e) => setApiKey(e.target.value)}
                              disabled={!canWrite}
                            />
                            <Button
                              variant="outline"
                             
                              disabled={!canWrite || apiKey.trim().length < 8 || connecting !== null}
                              loading={connecting === provider.ref && keyOpen}
                              onClick={() => void connectWithKey(provider)}
                            >
                              {t('connect_key_button')}
                            </Button>
                          </SettingsRow>
                        </SettingsReveal>
                      ) : null}
                    </div>
                  )
                })
              )}
            </SettingsGroup>
          ) : null}

          {ended.length > 0 ? (
            <SettingsGroup label={t('group_ended')}>
              {ended.map((connection) => (
                <SettingsRow key={connection.id} label={connectionLabel(connection)}>
                  <SettingsRowNote>
                    {connection.ended_at ? t('ended_on', { date: formatDate(connection.ended_at) }) : t('ended')}
                  </SettingsRowNote>
                </SettingsRow>
              ))}
            </SettingsGroup>
          ) : null}
        </>
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}

function connectionLabel(connection: SpendConnectionJson): string {
  return connection.provider_company_name ? `${connection.provider_name} (${connection.provider_company_name})` : connection.provider_name
}

function ConnectionSettings({
  connection,
  canWrite,
  healthText,
  onDisconnect,
  onSaved,
}: {
  connection: SpendConnectionJson
  canWrite: boolean
  healthText: (code: string | null) => string
  onDisconnect: () => void
  onSaved: () => void
}) {
  const t = useTranslations('spend')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { accounts } = useAccounts()
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [draft, setDraft] = useState<SpendSettingsJson>(connection.resolved_settings)
  const [saving, setSaving] = useState(false)
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    setDraft(connection.resolved_settings)
  }, [connection.resolved_settings])

  useEffect(() => {
    let cancelled = false
    loadBasCatalog()
      .then((data) => {
        if (!cancelled) setCatalog(data)
      })
      .catch(() => {
        /* search degrades to the active chart */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(connection.resolved_settings), [draft, connection.resolved_settings])

  const state =
    connection.health === 'action_required'
      ? t('health_state_action', { reason: healthText(connection.health_code) })
      : connection.health === 'degraded'
        ? t('health_state_degraded', { reason: healthText(connection.health_code) })
        : connection.last_success_at
          ? t('health_state_ok', { date: formatDate(connection.last_success_at) })
          : t('health_state_waiting')

  async function fetchNow() {
    setFetching(true)
    try {
      const res = await fetch('/api/spend/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connection.id }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('fetch_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      const results = (json.data?.results ?? []) as Array<{ status: string; received: number; errorCode?: string }>
      const failed = results.find((r) => r.status === 'failed')
      const received = results.reduce((sum, r) => sum + r.received, 0)
      if (failed) toast({ title: t('fetch_failed'), description: healthText(failed.errorCode ?? null), variant: 'destructive' })
      else toast({ title: received > 0 ? t('fetch_done', { count: received }) : t('fetch_nothing') })
      onSaved()
    } catch {
      toast({ title: t('fetch_failed'), variant: 'destructive' })
    } finally {
      setFetching(false)
    }
  }

  async function save() {
    const wallet = draft.wallet_account
    if ((wallet !== null && !isWalletAccount(wallet)) || !isAccountNumber(draft.out_of_pocket_account)) {
      toast({ title: t('save_failed'), description: t('save_invalid_account'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/spend/connections/${connection.id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('save_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      toast({ title: t('saved_toast', { count: json.data?.reevaluated_items ?? 0 }) })
      onSaved()
    } catch {
      toast({ title: t('save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SettingsGroup label={t('group_connection')}>
        <SettingsRow label={connectionLabel(connection)}>
          <SettingsRowNote className={connection.health === 'ok' ? undefined : 'text-attn'}>{state}</SettingsRowNote>
          <SettingsRowEnd>
            <Button variant="ghost" disabled={!canWrite} loading={fetching} onClick={() => void fetchNow()}>
              {t('fetch_now')}
            </Button>
            <Button variant="outline" disabled={!canWrite} onClick={onDisconnect}>
              {t('disconnect_button')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('group_accounts')} help={t('group_accounts_help')}>
        <SettingsRow label={t('wallet_account_label')} align="baseline" help={t('wallet_account_help')}>
          <AccountCombobox
            flat
            value={draft.wallet_account ?? ''}
            accounts={accounts}
            catalog={catalog}
            disabled={!canWrite}
            onChange={(v) => setDraft((d) => ({ ...d, wallet_account: v.trim() === '' ? null : v.trim() }))}
          />
          {draft.wallet_account === null ? <SettingsRowNote>{t('wallet_account_none')}</SettingsRowNote> : null}
        </SettingsRow>
        <SettingsRow label={t('out_of_pocket_account_label')} align="baseline" help={t('out_of_pocket_account_help')}>
          <AccountCombobox
            flat
            value={draft.out_of_pocket_account}
            accounts={accounts}
            catalog={catalog}
            disabled={!canWrite}
            onChange={(v) => setDraft((d) => ({ ...d, out_of_pocket_account: v.trim() }))}
          />
        </SettingsRow>
      </SettingsGroup>

      {dirty ? (
        <div className="sticky bottom-0 flex items-center gap-4 border-t border-border bg-background px-1 pb-3 pt-4">
          <Button loading={saving} disabled={!canWrite} onClick={() => void save()}>
            {t('save')}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => setDraft(connection.resolved_settings)}>
            {t('discard')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
