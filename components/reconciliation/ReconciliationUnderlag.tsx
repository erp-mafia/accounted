'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { exceedsHostedUploadLimit, isShrinkableImage, tooLargeMessage } from '@/lib/documents/upload-size'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import type { ReconciliationAttachment } from '@/lib/reconciliation/schemas'

/**
 * The underlag of one account's balansdag: the files it was reconciled
 * against (kontoutdrag, engagemangsbesked, reskontralista, inventering).
 * Lists what is attached for the date, attaches more, and lets a member
 * withdraw a wrong file (a stamp, the file stays). Reads and writes the
 * attachments routes under /api/reconciliation/accounts/{key}/attachments.
 */

interface ReconciliationUnderlagProps {
  accountKey: string
  /** The balansdag the files document: the sign-off date in play. */
  throughDate: string
  canWrite?: boolean
}

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ReconciliationUnderlag({ accountKey, throughDate, canWrite = true }: ReconciliationUnderlagProps) {
  const t = useTranslations('reconciliation_underlag')
  const { toast } = useToast()
  const [attachments, setAttachments] = useState<ReconciliationAttachment[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const base = `/api/reconciliation/accounts/${encodeURIComponent(accountKey)}/attachments`

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}?through_date=${throughDate}`)
      if (!res.ok) {
        setAttachments([])
        return
      }
      const json = await res.json()
      setAttachments((json.data?.attachments ?? []) as ReconciliationAttachment[])
    } catch {
      setAttachments([])
    }
  }, [base, throughDate])

  useEffect(() => {
    void load()
  }, [load])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy('upload')
    try {
      for (const original of Array.from(files)) {
        // Hosted functions refuse bodies over 4.5 MB before the route runs
        // (no logs, no message); shrink images, refuse the rest with a reason.
        let file = original
        if (exceedsHostedUploadLimit(file.size) && isShrinkableImage(file.type)) {
          file = await shrinkImageForUpload(file)
        }
        if (exceedsHostedUploadLimit(file.size)) {
          toast({ title: t('too_large_title'), description: tooLargeMessage(file.size), variant: 'destructive' })
          continue
        }
        const form = new FormData()
        form.set('file', file)
        form.set('through_date', throughDate)
        const res = await fetch(base, { method: 'POST', body: form })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast({ title: t('upload_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
          continue
        }
        toast({ title: t('attached', { name: file.name }) })
      }
      await load()
    } finally {
      setBusy(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function remove(attachment: ReconciliationAttachment) {
    setBusy(attachment.id)
    try {
      const res = await fetch(`${base}/${attachment.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('remove_failed'), description: getUserErrorMessage(json, { statusCode: res.status }), variant: 'destructive' })
        return
      }
      toast({ title: t('removed', { name: attachment.file_name }) })
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label={t('heading')} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
          {t('heading_dated', { date: formatDate(throughDate) })}
        </h3>
        {canWrite && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              onChange={(e) => void upload(e.target.files)}
              aria-label={t('attach')}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={busy !== null}
              aria-busy={busy === 'upload'}
            >
              <Paperclip className="h-3.5 w-3.5" />
              {t('attach')}
            </Button>
          </>
        )}
      </div>
      {attachments === null ? null : attachments.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="max-w-[560px] divide-y divide-border/60 text-[13px]">
          {attachments.map((a) => (
            <li key={a.id} className="group flex items-center gap-3 py-1.5">
              <a
                href={`${base}/${a.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(QUIET_LINK_CLASS, 'min-w-0 flex-1 truncate')}
                data-ph-mask
              >
                {a.file_name}
              </a>
              <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                {formatSize(a.size_bytes)} · {formatDate(a.uploaded_at)}
              </span>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => void remove(a)}
                  disabled={busy !== null}
                  className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS, 'shrink-0')}
                >
                  {t('remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
