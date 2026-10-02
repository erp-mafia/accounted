'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { PipelineView } from '@/app/api/documents/[id]/pipeline/route'
import { DOC_TYPES } from '@/lib/documents/classify/taxonomy'
import { cn } from '@/lib/utils'
import { ARKIV } from './palette'

/**
 * The sorting moment (canvas page Flöde): drop a file anywhere in Arkiv and
 * watch it being read, get its type, and slide to where it landed with a
 * line that says so: Underlag for what will be booked, its own page for
 * what describes the company, Granska for what nobody could place. The
 * pipeline is advanced while the person watches, so it lands in seconds.
 */
interface Tracked {
  key: string
  fileName: string
  documentId: string | null
  view: PipelineView | null
  failed: string | null
  done: boolean
  leaving: boolean
}

const POLL_MS = 1500
const MAX_POLLS = 80
const LINGER_MS = 3200

export function UploadDrop({ onLanded, className }: { onLanded?: (view: PipelineView) => void; className?: string }) {
  const t = useTranslations('arkiv')
  const [rows, setRows] = useState<Tracked[]>([])
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const patch = useCallback((key: string, change: Partial<Tracked>) => {
    if (!alive.current) return
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)))
  }, [])

  const track = useCallback(
    async (key: string, documentId: string) => {
      for (let i = 0; i < MAX_POLLS && alive.current; i++) {
        const res = await fetch(`/api/documents/${documentId}/pipeline?advance=1`)
        if (!res.ok) {
          patch(key, { failed: t('upload_failed') })
          return
        }
        const { data } = (await res.json()) as { data: PipelineView }
        patch(key, { view: data })
        if (data.stage === 'failed') {
          patch(key, { failed: t('stage_failed') })
          return
        }
        if (data.stage === 'landed') {
          patch(key, { done: true })
          onLanded?.(data)
          window.setTimeout(() => patch(key, { leaving: true }), LINGER_MS)
          window.setTimeout(() => {
            if (alive.current) setRows((rs) => rs.filter((r) => r.key !== key))
          }, LINGER_MS + 600)
          return
        }
        await new Promise((r) => window.setTimeout(r, POLL_MS))
      }
    },
    [onLanded, patch, t],
  )

  const upload = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        setRows((rs) => [...rs, { key, fileName: file.name, documentId: null, view: null, failed: null, done: false, leaving: false }])
        try {
          const fd = new FormData()
          fd.append('file', file)
          fd.append('upload_source', 'file_upload')
          const res = await fetch('/api/documents', { method: 'POST', body: fd })
          if (!res.ok) throw new Error(String(res.status))
          const { data } = (await res.json()) as { data: { id: string } }
          patch(key, { documentId: data.id })
          void track(key, data.id)
        } catch {
          patch(key, { failed: t('upload_failed') })
        }
      }
    },
    [patch, t, track],
  )

  const typeLabel = (type: string | null) => (type && (DOC_TYPES as readonly string[]).includes(type) ? t(`types.${type}` as never) : null)
  const landingLine = (v: PipelineView) => {
    if (!v.landed) return null
    switch (v.landed.kind) {
      case 'underlag':
        return v.landed.matched ? t('landed_underlag_matched') : t('landed_underlag')
      case 'agreement':
        return v.landed.label ? `${t('landed_agreement')}: ${v.landed.label}` : t('landed_agreement')
      case 'authority':
        return t('landed_authority')
      case 'review':
        return t('landed_review')
      case 'held':
        return t('landed_held')
      default:
        return t('landed_document')
    }
  }
  const stageIndex = (v: PipelineView | null) => (!v ? 0 : v.stage === 'reading' ? 0 : v.stage === 'classifying' ? 1 : 2)

  return (
    <div className={cn('space-y-3', className)}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          void upload(Array.from(e.dataTransfer.files))
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center transition-colors duration-150',
          over ? 'border-foreground bg-secondary/60' : 'border-border hover:bg-secondary/35',
        )}
      >
        <span className="text-[13px] font-medium">{t('upload_title')}</span>
        <span className="max-w-md text-xs text-muted-foreground">{t('upload_hint')}</span>
        <Button size="sm" variant="outline" type="button" onClick={(e) => e.stopPropagation()} asChild>
          <label className="cursor-pointer">
            {t('upload_pick')}
            <input
              ref={input}
              type="file"
              multiple
              // No image/heic here on purpose: when HEIC is absent from accept, iOS
              // Safari transcodes photo-library picks to JPEG (the inbox does the
              // same). A HEIC dropped from a Mac is still taken and decoded server-side.
              accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,.docx,.xlsx,.txt,.html"
              className="sr-only"
              onChange={(e) => void upload(Array.from(e.target.files ?? []))}
            />
          </label>
        </Button>
      </div>

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => {
            const stage = stageIndex(r.view)
            const type = r.view?.doc_type ? typeLabel(r.view.doc_type) : null
            const line = r.view ? landingLine(r.view) : null
            return (
              <li
                key={r.key}
                className={cn(
                  'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-[13px] motion-safe:transition-[transform,opacity] motion-safe:duration-300',
                  r.leaving && 'motion-safe:translate-x-6 motion-safe:opacity-0',
                )}
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={r.fileName}>
                  {r.view?.title && r.view.title !== r.fileName ? r.view.title : r.fileName}
                </span>
                {type ? <Badge variant="secondary">{type}</Badge> : null}
                {r.failed ? (
                  <span className="text-attn">{r.failed}</span>
                ) : r.done && r.view?.landed ? (
                  <Link href={r.view.landed.href} className="underline decoration-border underline-offset-4 hover:text-foreground">
                    → {line}
                  </Link>
                ) : (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {[t('stage_reading'), t('stage_classifying'), t('stage_landing')].map((label, i) => (
                      <span key={label} className="flex items-center gap-1.5">
                        <i
                          className={cn('inline-block h-[7px] w-[7px] rounded-full', i < stage ? 'bg-foreground' : i === stage ? 'motion-safe:animate-pulse' : 'bg-border')}
                          style={i === stage ? { background: ARKIV.sage } : undefined}
                        />
                        <span className={i === stage ? 'text-foreground' : ''}>{i === 2 && line ? `${label}: ${line}` : label}</span>
                      </span>
                    ))}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
