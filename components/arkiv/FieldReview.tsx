'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { ExtractionView } from '@/app/api/documents/[id]/extraction/route'

/** Label of a record field; a field without a translation shows its name. */
export function useFieldLabel(): (name: string) => string {
  const t = useTranslations('arkiv.fields')
  return (name) => (t.has(name) ? t(name) : name)
}

interface FieldReviewProps {
  documentId: string
  onSaved: () => void
  onFailed: () => void
}

/**
 * The fields of one document a person must settle. Each shows what the two
 * readings said, with page and quote; clicking a reading takes its value.
 * One confirm saves every field as typed; the server normalizes.
 */
export function FieldReview({ documentId, onSaved, onFailed }: FieldReviewProps) {
  const t = useTranslations('arkiv')
  const fieldLabel = useFieldLabel()
  const [view, setView] = useState<ExtractionView | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/documents/${documentId}/extraction`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const { data } = (await res.json()) as { data: ExtractionView }
        if (cancelled) return
        setView(data)
        setPicks(Object.fromEntries(data.review_fields.map((name) => [name, asText(data.payload[name]?.value)])))
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [documentId])

  const pick = (name: string, value: string) => setPicks((current) => ({ ...current, [name]: value }))

  const save = async () => {
    if (!view) return
    setSaving(true)
    try {
      const fields = Object.fromEntries(view.review_fields.map((name) => [name, picks[name]?.trim() || null]))
      const res = await fetch(`/api/documents/${documentId}/extraction/fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      })
      if (!res.ok) throw new Error(String(res.status))
      onSaved()
    } catch {
      onFailed()
    } finally {
      setSaving(false)
    }
  }

  if (loadFailed) return <p className="text-[13px] text-muted-foreground">{t('field_load_failed')}</p>
  if (!view) return <Skeleton className="h-16 w-full" />

  return (
    <div className="space-y-3 py-2">
      {view.review_fields.map((name) => {
        const failed = view.validation.find((c) => c.field === name)
        return (
          <div key={name} className="grid gap-1 sm:grid-cols-[200px_1fr_220px] sm:items-start">
            <div className="text-[13px] font-medium">{fieldLabel(name)}</div>
            <div className="space-y-0.5 text-xs text-muted-foreground">
              {(view.payload[name]?.readings ?? []).map((reading, i) => (
                <div key={i} className="flex flex-wrap gap-x-2">
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    onClick={() => pick(name, asText(reading.value))}
                  >
                    {t('reading', { n: i + 1 })}: {reading.value == null ? t('no_value') : asText(reading.value)}
                  </button>
                  {reading.page != null && <span className="tabular-nums">{t('page_ref', { page: reading.page })}</span>}
                  {reading.quote && <span className="italic">”{reading.quote}”</span>}
                </div>
              ))}
              {failed && <div className="text-destructive">{t(`checks.${failed.check}`)}</div>}
            </div>
            <Input
              id={`field-${documentId}-${name}`}
              value={picks[name] ?? ''}
              onChange={(e) => pick(name, e.target.value)}
              className="h-8 text-[13px]"
            />
          </div>
        )
      })}
      <div className="flex justify-end">
        <Button size="sm" disabled={saving} onClick={save}>
          {t('confirm_fields')}
        </Button>
      </div>
    </div>
  )
}

function asText(value: string | number | null | undefined): string {
  return value == null ? '' : String(value)
}
