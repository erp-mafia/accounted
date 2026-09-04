'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import type { RegistryCandidatesResult } from '@/lib/parties/registry-search'
import { formatOrgNumber } from '@/lib/utils'

function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * "SCB hittar två företag som liknar Adobe Systems Software, vilket menar
 * du?" The picker for a party without an org number: the user chooses,
 * the org number lands on the party, and every later fetch is by number.
 * One match is still shown, never auto-picked.
 */
export function ScbPickerDialog({
  open,
  onOpenChange,
  partyId,
  partyName,
  busy,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  partyId: string
  partyName: string
  busy: boolean
  onPick: (candidate: ScbCandidate) => Promise<void>
}) {
  const t = useTranslations('parties')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState<{ key: string; result: RegistryCandidatesResult | null; failed: boolean } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const key = `${partyId}:${query.trim()}`
  const current = loaded && loaded.key === key ? loaded : null
  const loading = open && current === null

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
        const res = await fetch(`/api/parties/${partyId}/enrich/candidates${params}`, { signal: ctrl.signal })
        const json = (await res.json()) as { data?: RegistryCandidatesResult }
        if (!cancelled) setLoaded({ key, result: res.ok ? (json.data ?? null) : null, failed: !res.ok })
      } catch {
        if (!cancelled) setLoaded({ key, result: null, failed: true })
      }
    }, query.trim() ? 300 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [open, partyId, query, key])

  const result = current?.result ?? null
  const candidates = result?.candidates ?? []
  const foreign = !query.trim() && result?.foreign ? result.foreign : null
  const foreignPlace = foreign?.country ? ` (${regionName(foreign.country, locale)})` : ''
  // Other readings of the voucher text, offered when the one used found nothing.
  const alternates = result && candidates.length === 0 && !query.trim() ? result.queries.filter((q) => q !== result.query) : []
  const chosen = candidates.find((c) => c.orgNumber === selected) ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('picker_title')}</DialogTitle>
          <DialogDescription>
            {result && !current?.failed
              ? result.truncated
                ? t('picker_too_many', { count: result.total, query: result.query })
                : candidates.length === 0
                  ? foreign
                    ? t('picker_foreign', { name: foreign.name, place: foreignPlace })
                    : t('picker_none', { query: result.query })
                  : t('picker_found', { count: candidates.length, query: result.query })
              : t('picker_body', { name: partyName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {result?.aiRead && !query.trim() && !loading ? <p className="text-sm text-muted-foreground">{t('picker_ai_read', { name: result.aiRead.name })}</p> : null}
          {foreign && candidates.length === 0 && !loading ? <p className="text-sm text-muted-foreground">{t('picker_foreign_hint')}</p> : null}
          {alternates.length > 0 && !loading ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t('picker_try_instead')}</span>
              {alternates.map((q) => (
                <Button key={q} type="button" variant="outline" size="sm" onClick={() => setQuery(q)}>
                  {q}
                </Button>
              ))}
            </div>
          ) : null}
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(null)
            }}
            placeholder={t('picker_search_placeholder')}
            aria-label={t('picker_search_placeholder')}
          />
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : current?.failed ? (
            <p className="text-sm text-muted-foreground">{t('registry_unavailable_title')}</p>
          ) : candidates.length > 0 ? (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border" role="listbox" aria-label={t('picker_title')}>
              {candidates.map((c) => {
                const isSelected = selected === c.orgNumber
                return (
                  <li key={c.orgNumber}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => setSelected(c.orgNumber)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left text-[13px] transition-colors duration-150 hover:bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${isSelected ? 'bg-secondary/60' : ''}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{c.name}</span>
                          {!c.active ? <Badge variant="warning">{c.status ?? t('picker_inactive')}</Badge> : null}
                        </div>
                        <div className="truncate text-xs text-muted-foreground tabular-nums">
                          {[formatOrgNumber(c.orgNumber), c.city, c.industry].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" onClick={() => (chosen ? void onPick(chosen) : undefined)} disabled={busy || !chosen}>
            {chosen ? t('picker_confirm', { name: chosen.name }) : t('picker_confirm_empty')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
