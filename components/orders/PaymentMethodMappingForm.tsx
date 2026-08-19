'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsInput,
} from '@/components/settings/SettingsRows'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants/account-number'
import { DEFAULT_PAYMENT_ACCOUNT } from '@/lib/webshop-orders/booking-lines'
import type { WebshopPaymentMethodPolicy, WebshopPlatform, WebshopStoreSettings } from '@/types'

interface PaymentMethodMappingFormProps {
  platform: WebshopPlatform
  storeScope: string
  /**
   * Payment methods observed on this store's orders. Omitted: derived from a
   * sample of the store's synced orders.
   */
  methods?: Array<{ method: string; title: string | null }>
}

type DraftPolicy = { mode: 'book'; account: string } | { mode: 'invoice' }

/**
 * Per-store payment-method -> account mapping (prefill only; never books).
 * Fönster language: flat hairline rows, save appears only when dirty.
 * "Faktureras" marks a method as invoice-flow: the booking dialog then nudges
 * toward Skapa faktura for those orders.
 */
export function PaymentMethodMappingForm({
  platform,
  storeScope,
  methods,
}: PaymentMethodMappingFormProps) {
  const t = useTranslations('webshop_orders')
  const { toast } = useToast()
  const [saved, setSaved] = useState<Record<string, WebshopPaymentMethodPolicy>>({})
  const [draft, setDraft] = useState<Record<string, DraftPolicy>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [derivedMethods, setDerivedMethods] = useState<
    Array<{ method: string; title: string | null }>
  >([])

  useEffect(() => {
    if (methods !== undefined) return
    let cancelled = false
    fetch(
      `/api/webshop-orders?platform=${platform}&store_scope=${encodeURIComponent(storeScope)}&limit=200`,
    )
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then(
        (json: {
          data: Array<{ payment_method: string | null; payment_method_title: string | null }>
        }) => {
          if (cancelled) return
          const seen = new Map<string, string | null>()
          for (const row of json.data ?? []) {
            if (row.payment_method && !seen.has(row.payment_method)) {
              seen.set(row.payment_method, row.payment_method_title)
            }
          }
          setDerivedMethods(
            Array.from(seen.entries()).map(([method, title]) => ({ method, title })),
          )
        },
      )
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [methods, platform, storeScope])

  useEffect(() => {
    let cancelled = false
    fetch(
      `/api/webshop-orders/settings?platform=${platform}&store_scope=${encodeURIComponent(storeScope)}`,
    )
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json: { data: WebshopStoreSettings[] }) => {
        if (cancelled) return
        const map = json.data[0]?.payment_method_account_map ?? {}
        setSaved(map)
        setDraft(map as Record<string, DraftPolicy>)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [platform, storeScope])

  // Methods seen on orders plus any mapped-but-no-longer-seen leftovers.
  const rows = useMemo(() => {
    const source = methods ?? derivedMethods
    const known = new Map(source.map((m) => [m.method, m.title]))
    for (const method of Object.keys(saved)) {
      if (!known.has(method)) known.set(method, null)
    }
    return Array.from(known.entries()).map(([method, title]) => ({ method, title }))
  }, [methods, derivedMethods, saved])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  const setMode = (method: string, mode: 'book' | 'invoice') => {
    setDraft((prev) => {
      const current = prev[method]
      if (mode === 'invoice') return { ...prev, [method]: { mode: 'invoice' } }
      return {
        ...prev,
        [method]: {
          mode: 'book',
          // Same constant the booking prefill falls back to: a hardcoded
          // number here would silently drift from it (it just did).
          account: current?.mode === 'book' ? current.account : DEFAULT_PAYMENT_ACCOUNT,
        },
      }
    })
  }

  const setAccount = (method: string, account: string) => {
    setDraft((prev) => ({ ...prev, [method]: { mode: 'book', account } }))
  }

  const invalid = Object.values(draft).some(
    (p) => p.mode === 'book' && !ACCOUNT_NUMBER_RE.test(p.account),
  )

  async function save() {
    setSaving(true)
    try {
      const res = await fetch('/api/webshop-orders/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          store_scope: storeScope,
          payment_method_account_map: draft,
        }),
      })
      if (!res.ok) throw new Error(`save failed: ${res.status}`)
      const json = (await res.json()) as { data: WebshopStoreSettings }
      setSaved(json.data.payment_method_account_map)
      setDraft(json.data.payment_method_account_map as Record<string, DraftPolicy>)
      toast({ title: t('mapping_saved') })
    } catch {
      toast({ title: t('mapping_save_failed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (loading || rows.length === 0) return null

  return (
    <SettingsGroup label={t('mapping_title')}>
      <p className="px-1 pb-1 text-xs leading-relaxed text-muted-foreground">
        {t('mapping_intro')}
      </p>
      {rows.map(({ method, title }) => {
        const policy = draft[method]
        const mode = policy?.mode ?? 'book'
        const account = policy?.mode === 'book' ? policy.account : ''
        return (
          <SettingsRow key={method} label={<span data-ph-mask="">{title || method}</span>}>
            <SettingsRowEnd>
              <select
                value={policy ? mode : 'unmapped'}
                onChange={(e) => {
                  if (e.target.value === 'unmapped') {
                    setDraft((prev) => {
                      const next = { ...prev }
                      delete next[method]
                      return next
                    })
                  } else {
                    setMode(method, e.target.value as 'book' | 'invoice')
                  }
                }}
                className="rounded-full border border-border bg-transparent px-3 py-[5px] text-[13px]"
                aria-label={t('mapping_mode_aria', { method: title || method })}
              >
                <option value="unmapped">{t('mapping_mode_unmapped')}</option>
                <option value="book">{t('mapping_mode_book')}</option>
                <option value="invoice">{t('mapping_mode_invoice')}</option>
              </select>
              {policy?.mode === 'book' && (
                <SettingsInput
                  value={account}
                  onChange={(e) => setAccount(method, e.target.value.trim())}
                  inputMode="numeric"
                  maxLength={4}
                  className="w-20 text-right tabular-nums"
                  aria-label={t('mapping_account_aria', { method: title || method })}
                />
              )}
            </SettingsRowEnd>
          </SettingsRow>
        )
      })}
      <div className="flex items-center justify-between px-1 pt-3">
        <SettingsRowNote>{t('mapping_note')}</SettingsRowNote>
        {dirty && (
          <Button size="sm" onClick={save} disabled={saving || invalid}>
            {saving ? t('mapping_saving') : t('mapping_save')}
          </Button>
        )}
      </div>
    </SettingsGroup>
  )
}
