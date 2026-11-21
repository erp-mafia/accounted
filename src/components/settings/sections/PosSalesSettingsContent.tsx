'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import {
  SettingsBackLink,
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { usePosHealthText } from '@/components/pos-sales/reason-text'
import type { PosConnectionJson, PosSettingsJson, PosTenderKind } from '@/components/pos-sales/types'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { isAccountNumber } from '@/lib/invariants'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useAccounts } from '@/lib/reference-data/hooks'
import { formatDate } from '@/lib/utils'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

interface VenueJson {
  provider: { ref: string; displayName: string; accessRequestSv: string | null }
  venueRef: string
  name: string
  connected: boolean
  available: boolean
}

interface VenuesJson {
  venues: VenueJson[]
  providers: Array<{ ref: string; displayName: string; accessRequestSv: string | null }>
  org_number: string
}

const TENDER_ROWS: ReadonlyArray<{ kind: PosTenderKind; nullable: boolean }> = [
  { kind: 'card', nullable: true },
  { kind: 'swish', nullable: true },
  { kind: 'cash', nullable: true },
  { kind: 'gift_card', nullable: true },
  { kind: 'invoice', nullable: true },
  { kind: 'prepaid', nullable: true },
  { kind: 'other', nullable: true },
]

function yesterday(): string {
  return addDaysIso(todayIsoStockholm(), -1)
}

/**
 * Kopplingar -> Kassasystem: connect a POS venue through Accounted Connect,
 * see whether its daily fetch works, and choose the accounts its days are
 * booked to. The venues listed are the ones a POS provider has opened for
 * Accounted and Arcim has matched to this company's organisation number:
 * nobody types a venue id here.
 */
export function PosSalesSettingsContent() {
  const t = useTranslations('pos_sales')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const healthText = usePosHealthText()
  const { dialogProps, confirm } = useDestructiveConfirm()
  const [connections, setConnections] = useState<PosConnectionJson[] | null>(null)
  const [available, setAvailable] = useState(true)
  // The connections read failed. message: the server's sentence for a 4xx
  // about the company (no retry helps); null: a failed read, with a retry.
  // Never the "Accounted Connect is not configured" text: that is only true
  // after a real answer says so.
  const [connectionsError, setConnectionsError] = useState<{ message: string | null } | null>(null)
  const [venues, setVenues] = useState<VenuesJson | null>(null)
  const [venuesError, setVenuesError] = useState<string | null>(null)
  const [syncFrom, setSyncFrom] = useState<string>(yesterday())
  const [connecting, setConnecting] = useState<string | null>(null)

  const load = useCallback(async () => {
    let res: Response
    try {
      res = await fetch('/api/pos-sales/connections')
    } catch {
      setConnectionsError({ message: null })
      return
    }
    const json = (await res.json().catch(() => null)) as { data?: { connections: PosConnectionJson[]; available: boolean } } | null
    if (!res.ok || !json?.data) {
      const aboutCompany = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
      setConnectionsError({
        message: aboutCompany ? getErrorMessage(json, { statusCode: res.status, locale: errorLocale }) : null,
      })
      return
    }
    setConnectionsError(null)
    setConnections(json.data.connections ?? [])
    setAvailable(json.data.available ?? false)
    if (!json.data.available) return
    try {
      const venuesRes = await fetch('/api/pos-sales/venues')
      const venuesJson = await venuesRes.json()
      if (!venuesRes.ok) {
        setVenues(null)
        setVenuesError(getErrorMessage(venuesJson, { statusCode: venuesRes.status, locale: errorLocale }))
        return
      }
      setVenuesError(null)
      setVenues(venuesJson.data as VenuesJson)
    } catch {
      setVenuesError(t('venues_failed'))
    }
  }, [errorLocale, t])

  useEffect(() => {
    void load()
  }, [load])

  const active = (connections ?? []).filter((c) => c.status === 'active')
  const connectable = (venues?.venues ?? []).filter((v) => !v.connected)

  async function connect(venue: VenueJson) {
    setConnecting(venue.venueRef)
    try {
      const res = await fetch('/api/pos-sales/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: venue.provider.ref, venue_ref: venue.venueRef, sync_from: syncFrom }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('connect_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      toast({ title: t('connected_toast', { venue: venue.name }) })
      void load()
    } catch {
      toast({ title: t('connect_failed'), variant: 'destructive' })
    } finally {
      setConnecting(null)
    }
  }

  async function disconnect(connection: PosConnectionJson) {
    await confirm(
      {
        title: t('disconnect_title', { venue: connection.venue_name }),
        description: t('disconnect_description'),
        confirmLabel: t('disconnect_confirm'),
      },
      async () => {
        const res = await fetch(`/api/pos-sales/connections/${connection.id}/disconnect`, { method: 'POST' })
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
      <SettingsSectionHeader title={tNav('pos')} intro={tIntro('pos')} />

      {connectionsError && connections !== null && (
        <AttnLine className="pt-6" action={{ label: tCommon('retry'), onClick: () => void load() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}

      {connectionsError && connections === null ? (
        connectionsError.message ? (
          <EmptyState title={connectionsError.message} />
        ) : (
          <LoadError
            title={t('connections_load_failed')}
            onRetry={() => {
              setConnectionsError(null)
              void load()
            }}
          />
        )
      ) : connections === null ? (
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
              {venuesError ? (
                <SettingsRow label={t('venues_label')}>
                  <SettingsRowNote>{venuesError}</SettingsRowNote>
                  <SettingsRowEnd>
                    <Button variant="outline" onClick={() => void load()}>
                      {t('retry')}
                    </Button>
                  </SettingsRowEnd>
                </SettingsRow>
              ) : connectable.length === 0 ? (
                (venues?.providers ?? []).map((provider) => (
                  <SettingsRow key={provider.ref} label={provider.displayName} help={provider.accessRequestSv ?? undefined}>
                    <SettingsRowNote>{t('no_venue_yet', { org: venues?.org_number ?? '' })}</SettingsRowNote>
                  </SettingsRow>
                ))
              ) : (
                <>
                  <SettingsRow label={t('sync_from_label')} htmlFor="pos-sync-from" help={t('sync_from_help')} align="baseline">
                    <SettingsInput
                      id="pos-sync-from"
                      type="date"
                      value={syncFrom}
                      max={yesterday()}
                      onChange={(e) => setSyncFrom(e.target.value)}
                      disabled={!canWrite}
                    />
                  </SettingsRow>
                  {connectable.map((venue) => (
                    <SettingsRow key={`${venue.provider.ref}:${venue.venueRef}`} label={`${venue.name} (${venue.provider.displayName})`}>
                      {!venue.available ? <SettingsRowNote>{t('venue_taken')}</SettingsRowNote> : null}
                      <SettingsRowEnd>
                        <Button
                          variant="outline"
                          disabled={!canWrite || !venue.available || !syncFrom}
                          loading={connecting === venue.venueRef}
                          onClick={() => void connect(venue)}
                        >
                          {t('connect_button')}
                        </Button>
                      </SettingsRowEnd>
                    </SettingsRow>
                  ))}
                </>
              )}
            </SettingsGroup>
          ) : null}
        </>
      )}

      <DestructiveConfirmDialog {...dialogProps} />
    </div>
  )
}

function ConnectionSettings({
  connection,
  canWrite,
  healthText,
  onDisconnect,
  onSaved,
}: {
  connection: PosConnectionJson
  canWrite: boolean
  healthText: (code: string | null) => string
  onDisconnect: () => void
  onSaved: () => void
}) {
  const t = useTranslations('pos_sales')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { accounts } = useAccounts()
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [draft, setDraft] = useState<PosSettingsJson>(connection.resolved_settings)
  const [saving, setSaving] = useState(false)

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
        : connection.synced_through
          ? t('health_state_ok', { date: formatDate(connection.synced_through) })
          : t('health_state_waiting', { date: formatDate(connection.sync_from) })

  function setTender(kind: PosTenderKind, value: string | null) {
    setDraft((d) => ({ ...d, tender_accounts: { ...d.tender_accounts, [kind]: value } }))
  }

  async function save() {
    const named: Array<string | null> = [
      ...Object.values(draft.tender_accounts),
      ...Object.values(draft.revenue_accounts),
      ...Object.values(draft.vat_accounts),
      draft.tips_account,
      draft.rounding_account,
    ]
    if (named.some((a) => a !== null && !isAccountNumber(a)) || !draft.tips_account || !draft.rounding_account) {
      toast({ title: t('save_failed'), description: t('save_invalid_account'), variant: 'destructive' })
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/pos-sales/connections/${connection.id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: draft }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast({ title: t('save_failed'), description: getErrorMessage(json, { statusCode: res.status, locale: errorLocale }), variant: 'destructive' })
        return
      }
      toast({ title: t('saved_toast', { count: json.data?.reevaluated_days ?? 0 }) })
      onSaved()
    } catch {
      toast({ title: t('save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const accountField = (value: string | null, onChange: (v: string | null) => void, nullable: boolean) => (
    <>
      <AccountCombobox
        flat
        value={value ?? ''}
        accounts={accounts}
        catalog={catalog}
        disabled={!canWrite}
        onChange={(v) => onChange(v.trim() === '' && nullable ? null : v.trim())}
      />
      {nullable && value === null ? <SettingsRowNote>{t('account_none')}</SettingsRowNote> : null}
    </>
  )

  return (
    <>
      <SettingsGroup label={t('group_connection')}>
        <SettingsRow label={`${connection.venue_name} (${connection.provider_name})`}>
          <SettingsRowNote className={connection.health === 'ok' ? undefined : 'text-attn'}>{state}</SettingsRowNote>
          <SettingsRowEnd>
            <Button variant="outline" disabled={!canWrite} onClick={onDisconnect}>
              {t('disconnect_button')}
            </Button>
          </SettingsRowEnd>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={t('group_payments')} help={t('group_payments_help')}>
        {TENDER_ROWS.map(({ kind, nullable }) => (
          <SettingsRow key={kind} label={t(`tender_${kind}`)} align="baseline">
            {accountField(draft.tender_accounts[kind], (v) => setTender(kind, v), nullable)}
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup label={t('group_sales')} help={t('group_sales_help')}>
        {(['25', '12', '6'] as const).map((rate) => (
          <SettingsRow key={`revenue-${rate}`} label={t('revenue_rate', { rate })} align="baseline">
            {accountField(draft.revenue_accounts[rate], (v) => setDraft((d) => ({ ...d, revenue_accounts: { ...d.revenue_accounts, [rate]: v } })), true)}
          </SettingsRow>
        ))}
        <SettingsRow label={t('revenue_zero')} align="baseline" help={t('revenue_zero_help')}>
          {accountField(draft.revenue_accounts['0'], (v) => setDraft((d) => ({ ...d, revenue_accounts: { ...d.revenue_accounts, '0': v } })), true)}
        </SettingsRow>
        {(['25', '12', '6'] as const).map((rate) => (
          <SettingsRow key={`vat-${rate}`} label={t('vat_rate', { rate })} align="baseline">
            {accountField(draft.vat_accounts[rate], (v) => setDraft((d) => ({ ...d, vat_accounts: { ...d.vat_accounts, [rate]: v } })), true)}
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup label={t('group_other')}>
        <SettingsRow label={t('tips_label')} align="baseline" help={t('tips_help')}>
          {accountField(draft.tips_account, (v) => setDraft((d) => ({ ...d, tips_account: v ?? '' })), false)}
        </SettingsRow>
        <SettingsRow label={t('rounding_label')} align="baseline" help={t('rounding_help')}>
          {accountField(draft.rounding_account, (v) => setDraft((d) => ({ ...d, rounding_account: v ?? '' })), false)}
        </SettingsRow>
      </SettingsGroup>

      {dirty ? (
        <div className="sticky bottom-[var(--bottom-nav-h)] flex items-center gap-4 border-t-hairline bg-background px-1 pb-3 pt-4">
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
