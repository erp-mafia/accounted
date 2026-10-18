'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import type { ArrivalSummary } from '@/lib/intake/arrivals'
import {
  formatOriginalSize,
  originalViewFor,
  provenanceFor,
  provenanceLine,
  showableArrivals,
  type OriginalView,
  type ProvenanceOptions,
} from '@/lib/intake/arrival-display'
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout'
import { createClient } from '@/lib/supabase/client'
import { cn, formatDateLong, formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'

// Same budget as the document read beside it: one indexed lookup plus a
// storage sign call per original.
const ARRIVALS_FETCH_TIMEOUT_MS = 15_000

async function fetchDocumentArrivals(documentId: string): Promise<ArrivalSummary[]> {
  const res = await fetchWithTimeout(
    `/api/documents/${documentId}/arrivals`,
    { method: 'GET' },
    { timeoutMs: ARRIVALS_FETCH_TIMEOUT_MS, description: `arrivals ${documentId}` },
  )
  if (!res.ok) throw new Error(`arrivals ${res.status}`)
  const json = (await res.json()) as { data?: unknown }
  return Array.isArray(json?.data) ? (json.data as ArrivalSummary[]) : []
}

type ArrivalsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; arrivals: ArrivalSummary[] }
  | { status: 'error' }

/**
 * The arrivals behind one document, read when the document is shown (never
 * per list row). `generation` forces a fresh read: the dialog bumps it on
 * every open, because the signed original URLs live 300 s.
 *
 * The answer is stored with the key it answered, so a switch to another
 * item reads as loading at once instead of showing the previous item's
 * arrivals until the new ones land.
 */
function useDocumentArrivals(documentId: string | null, generation = 0): ArrivalsState {
  const key = documentId ? `${documentId}:${generation}` : null
  const [answer, setAnswer] = useState<{ key: string; arrivals: ArrivalSummary[] | null } | null>(null)

  useEffect(() => {
    if (!documentId || !key) return
    let cancelled = false
    fetchDocumentArrivals(documentId).then(
      (arrivals) => {
        if (!cancelled) setAnswer({ key, arrivals })
      },
      () => {
        if (!cancelled) setAnswer({ key, arrivals: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [documentId, key])

  if (!key) return { status: 'idle' }
  if (!answer || answer.key !== key) return { status: 'loading' }
  return answer.arrivals ? { status: 'ready', arrivals: answer.arrivals } : { status: 'error' }
}

/**
 * The signed-in user's id, read from the local session (no network): only
 * to say "Uppladdad av dig" for the user's own uploads.
 */
function useCurrentUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    createClient()
      .auth.getSession()
      .then(
        ({ data }) => {
          if (!cancelled) setUserId(data.session?.user?.id ?? null)
        },
        () => {},
      )
    return () => {
      cancelled = true
    }
  }, [])
  return userId
}

/**
 * Where the selected Inkorg item came from, read off its arrivals: one
 * provenance line, the mail subject, "Kom även via ..." when it came in more
 * than once, and "Visa originalet".
 *
 * Until the arrivals answer, and for items with none recorded (from before
 * arrivals existed) or a failed read, it renders `fallback`: the provenance
 * the Inkorg showed before. Nothing here is louder than that fallback.
 */
export function InboxArrivalProvenance({
  documentId,
  mailProvider,
  fallback,
  variant = 'full',
  formatDate: formatDateOverride,
}: {
  /** The item's document; null for a placeholder or a mail-body item without one. */
  documentId: string | null
  /** The item's channel_context.mail_provider, for the connected-mailbox line. */
  mailProvider?: string | null
  fallback?: ReactNode
  /** full: the provenance lines and "Visa originalet". original_link: only "Visa originalet", where it can be shown. */
  variant?: 'full' | 'original_link'
  /** How a date reads in the provenance line; the long form unless the page has its own. */
  formatDate?: (iso: string) => string
}) {
  const t = useTranslations('inbox_arrivals')
  const locale = useLocale()
  const currentUserId = useCurrentUserId()
  const state = useDocumentArrivals(documentId)
  const [open, setOpen] = useState(false)
  const [generation, setGeneration] = useState(0)

  const options: ProvenanceOptions = {
    formatDate: formatDateOverride ?? ((iso) => formatDateLong(iso, locale)),
    currentUserId,
    mailProvider,
    documentId,
  }
  const display = state.status === 'ready' ? provenanceFor(state.arrivals, options) : null
  if (!display || !documentId) return <>{fallback ?? null}</>

  const originals = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dialog_title')}</DialogTitle>
          <DialogDescription>{t('dialog_description')}</DialogDescription>
        </DialogHeader>
        {/* Radix mounts the content only while open, so every open reads
            the arrivals anew (the generation was bumped by the click). */}
        <OriginalsBody
          documentId={documentId}
          generation={generation}
          options={options}
          onRetry={() => setGeneration((g) => g + 1)}
        />
      </DialogContent>
    </Dialog>
  )
  const showOriginal = (
    <button
      type="button"
      className={QUIET_LINK_CLASS}
      onClick={() => {
        setGeneration((g) => g + 1)
        setOpen(true)
      }}
    >
      {t('show_original')}
    </button>
  )

  if (variant === 'original_link') {
    if (!display.canShowOriginal) return null
    return (
      <>
        {showOriginal}
        {originals}
      </>
    )
  }

  const doors =
    display.alsoVia.length > 0
      ? new Intl.ListFormat(locale === 'en' ? 'en-US' : 'sv-SE', { style: 'long', type: 'conjunction' }).format(
          display.alsoVia.map((id) => t(`source.${id}`)),
        )
      : null

  return (
    <div className="border-b px-4 py-3 text-xs space-y-1">
      <p className="break-words">{t(display.line.key, display.line.values)}</p>
      {display.subject && (
        <p className="truncate text-muted-foreground" title={display.subject}>
          {t('subject', { subject: display.subject })}
        </p>
      )}
      {doors && <p className="text-muted-foreground">{t('also_via', { doors })}</p>}
      {display.canShowOriginal && <div className="pt-1">{showOriginal}</div>}
      {originals}
    </div>
  )
}

/** The originals, read fresh at every open so their signed URLs are new. */
function OriginalsBody({
  documentId,
  generation,
  options,
  onRetry,
}: {
  documentId: string
  generation: number
  options: ProvenanceOptions
  onRetry: () => void
}) {
  const t = useTranslations('inbox_arrivals')
  const state = useDocumentArrivals(documentId, generation)

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div className="space-y-2 text-[13px] text-muted-foreground">
        <p>{t('load_failed')}</p>
        <button type="button" className={QUIET_LINK_CLASS} onClick={onRetry}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const showable = showableArrivals(state.arrivals, options.documentId)
  if (showable.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
  }
  return (
    <div className="space-y-6">
      {showable.map((arrival, index) => {
        const line = provenanceLine(arrival, options)
        return (
          <section key={arrival.id} className={cn('space-y-3', index > 0 && 'border-t border-border pt-6')}>
            {showable.length > 1 && (
              <p className="text-[12.5px] text-muted-foreground">{t(line.key, line.values)}</p>
            )}
            <OriginalViewBody view={originalViewFor(arrival)} />
          </section>
        )
      })}
    </div>
  )
}

function MetaRows({ rows }: { rows: Array<[label: string, value: string | null | undefined, numeric?: boolean]> }) {
  const shown = rows.filter(([, value]) => !!value)
  if (shown.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
      {shown.map(([label, value, numeric]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={cn('break-words', numeric && 'tabular-nums')}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Every original is signed as a download (Content-Disposition: attachment), so the control says so. */
function OriginalLink({ url, fileName, children }: { url: string; fileName?: string | null; children: ReactNode }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={url} download={fileName ?? true} rel="noopener noreferrer">
        <Download className="h-3.5 w-3.5 mr-2" />
        {children}
      </a>
    </Button>
  )
}

function OriginalViewBody({ view }: { view: OriginalView }) {
  const t = useTranslations('inbox_arrivals')
  const locale = useLocale()
  const unavailable = <p className="text-[12.5px] text-muted-foreground">{t('url_unavailable')}</p>

  if (view.kind === 'mail') {
    return (
      <div className="space-y-3">
        <MetaRows
          rows={[
            [t('mail_from'), view.from],
            [t('mail_to'), view.to.join(', ')],
            [t('mail_cc'), view.cc.join(', ')],
            [t('mail_subject'), view.subject],
            [t('mail_date'), formatDateTime(view.receivedAt), true],
          ]}
        />
        {view.text ? (
          <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-4 font-sans text-[13px] leading-relaxed">
            {view.text}
          </pre>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t('mail_no_text')}</p>
        )}
        {!view.kept ? (
          <p className="text-[12.5px] text-muted-foreground">{t('mail_not_kept')}</p>
        ) : view.url ? (
          <OriginalLink url={view.url} fileName={view.fileName}>
            {t('mail_download')}
          </OriginalLink>
        ) : (
          unavailable
        )}
      </div>
    )
  }

  if (view.kind === 'einvoice') {
    return (
      <div className="space-y-3">
        <MetaRows
          rows={[
            [t('einvoice_sender'), view.senderName],
            [t('einvoice_endpoint'), view.endpoint, true],
            [t('einvoice_org_number'), view.orgNumber, true],
            [t('einvoice_date'), formatDateTime(view.receivedAt), true],
          ]}
        />
        <p className="text-[12.5px] text-muted-foreground">{t('einvoice_note')}</p>
        {view.url ? (
          <OriginalLink url={view.url} fileName={view.fileName}>
            {t('einvoice_download')}
          </OriginalLink>
        ) : (
          unavailable
        )}
      </div>
    )
  }

  if (view.kind === 'file') {
    return (
      <div className="space-y-3">
        <MetaRows
          rows={[
            [t('file_name'), view.fileName],
            [t('file_size'), formatOriginalSize(view.size, locale), true],
            [t('file_date'), formatDateTime(view.receivedAt), true],
          ]}
        />
        {view.url ? (
          <OriginalLink url={view.url} fileName={view.fileName}>
            {t('file_download')}
          </OriginalLink>
        ) : (
          unavailable
        )}
      </div>
    )
  }

  return null
}
