'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { CollectionsFeatures, ProviderProfile } from '@accounted/connect-contract'
import type { ActivationErrorKey } from '@/lib/collections/activation-form'
import type { CollectionsAvailability } from '@/lib/collections/availability'
import type { CollectionConnectionView } from '@/lib/collections/connection'
import { collectionsErrorMessage } from '@/lib/collections/errors'
import type { ActivationContext } from '@/lib/collections/connection-service'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Browser side of the collections settings: the data the page renders from,
 * the provider's name in a sentence, and the calls to the routes.
 */

export interface CollectionsSettingsData {
  availability: CollectionsAvailability
  connection: CollectionConnectionView | null
  provider: { profile: ProviderProfile; features: CollectionsFeatures } | null
  activation: ActivationContext | null
  canManage: boolean
}

export type Locale = 'sv' | 'en'

const FALLBACK_NAME: Record<Locale, string> = { sv: 'inkassobolaget', en: 'the collection agency' }

/**
 * The provider's name and its possessive, from the catalogue or the name
 * stored at activation, else the neutral word. Swedish adds -s unless the
 * name already ends in s, x or z ("inkassobolagets"); English adds 's.
 */
export function providerWords(name: string | null | undefined, locale: Locale): { provider: string; providerOwner: string } {
  const provider = name?.trim() || FALLBACK_NAME[locale]
  const providerOwner = locale === 'sv' ? (/[sxz]$/i.test(provider) ? provider : `${provider}s`) : `${provider}'s`
  return { provider, providerOwner }
}

/** A sentence that starts with the neutral word still starts with a capital. */
export function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** t() for settings_collections with the provider's words filled in. */
export function useCollectionsWords(name: string | null | undefined) {
  const t = useTranslations('settings_collections')
  const locale = (useLocale() === 'en' ? 'en' : 'sv') as Locale
  const words = providerWords(name, locale)
  const tp = useCallback(
    (key: string, values: Record<string, string | number> = {}) => capitalizeFirst(t(key, { ...words, ...values })),
    [t, words],
  )
  return { t, tp, locale, words }
}

export type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; message: string; fieldErrors: Record<string, ActivationErrorKey> }

/** POST or PATCH a collections settings route; field errors come back as keys, anything else as one sentence. */
export async function collectionsAction<T = unknown>(
  path: string,
  body: unknown,
  locale: Locale,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<ActionResult<T>> {
  try {
    const res = await fetch(`/api/settings/collections${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (res.ok) return { ok: true, data: (json?.data ?? null) as T }
    const fieldErrors: Record<string, ActivationErrorKey> = {}
    if (json?.type === 'validation_error' && Array.isArray(json.errors)) {
      for (const e of json.errors as { field?: string; message?: string }[]) {
        if (e.field && e.message) fieldErrors[e.field] = e.message as ActivationErrorKey
      }
    }
    return { ok: false, message: getErrorMessage(json, { statusCode: res.status, locale }), fieldErrors }
  } catch (error) {
    return { ok: false, message: getErrorMessage(error, { locale }), fieldErrors: {} }
  }
}

/** GET /api/settings/collections, with a reload. */
export function useCollectionsSettings() {
  const [data, setData] = useState<CollectionsSettingsData | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setFailed(false)
    try {
      const res = await fetch('/api/settings/collections', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const body = (await res.json()) as { data: CollectionsSettingsData }
      setData(body.data)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, failed, loading, reload, setData }
}

/** GET /api/collections/availability for the entry points elsewhere in settings; null until read or when the read fails. */
export function useCollectionsAvailability(): CollectionsAvailability | null {
  const [availability, setAvailability] = useState<CollectionsAvailability | null>(null)
  useEffect(() => {
    let active = true
    fetch('/api/collections/availability')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: CollectionsAvailability } | null) => {
        if (active && body?.data) setAvailability(body.data)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  return availability
}

/** Whether a settings entry point for collections should show at all. */
export function collectionsEntryShown(a: CollectionsAvailability | null): boolean {
  return !!a && (a.start !== 'hidden' || a.connection !== null || a.obligations)
}

/**
 * The sentence for a health cause stored on the connection (an error code,
 * or PROVIDER_DISCONNECTED), lower-cased to sit after "har problem:".
 */
export function collectionsErrorMessageFor(code: string | null, provider: string): string {
  if (!code) return ''
  const text = collectionsErrorMessage(code, { provider })
  return text.charAt(0).toLowerCase() + text.slice(1)
}
