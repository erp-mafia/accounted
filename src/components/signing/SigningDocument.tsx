'use client'

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'unpdf/pdfjs'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** How far outside the viewport a page is drawn ahead of the reader, and kept; further away its bitmap is let go. */
const NEAR_MARGIN = '150% 0px'
/**
 * The bottom of the last page counts as seen once it is this far above the
 * bottom of the viewport, clear of the sticky bar that holds the BankID button.
 */
const END_MARGIN = '0px 0px -128px 0px'
/** A resize redraws the pages at their new width once it has settled. */
const RESIZE_SETTLE_MS = 150

interface PageSize {
  width: number
  height: number
}

type Loaded = { kind: 'loading' } | { kind: 'ready'; pdf: PDFDocumentProxy; sizes: PageSize[] } | { kind: 'failed' }

export interface SigningDocumentProps {
  /** Where the PDF is served (same origin: the signer's document route). */
  url: string
  /** The file's name, for the page labels. */
  fileName: string
  /** The PDF is open: how many pages it has. */
  onLoaded: (pageCount: number) => void
  /** The page the reader is on now, 1-based. */
  onPage: (page: number) => void
  /** The bottom of the last page has been on screen, drawn (a one-page document: once it is drawn). */
  onReachedEnd: () => void
  /** The document could not be drawn here: the page offers the file itself instead. */
  onFailed: () => void
  /** The reader opened the file in the browser's own viewer, from the fallback. */
  onOpened: () => void
}

/**
 * The document being signed, drawn by us page by page so it can be the page
 * itself: pdf.js through unpdf's serverless build (`unpdf/pdfjs`, no worker),
 * loaded on the client only when the page opens. Every page is a sheet sized
 * from the PDF before anything is drawn, so the scroll height holds still;
 * a sheet is drawn at the screen's pixel density when it comes near the
 * viewport and let go when it is far away again, so a long document stays
 * light on a phone. If pdf.js cannot open or draw the file, the reader gets
 * the file itself: our renderer failing never stands between them and
 * signing.
 */
export function SigningDocument({ url, fileName, onLoaded, onPage, onReachedEnd, onFailed, onOpened }: SigningDocumentProps) {
  const t = useTranslations('signing_page')
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set())
  const [drawn, setDrawn] = useState<ReadonlySet<number>>(() => new Set())
  const [endSeen, setEndSeen] = useState(false)
  const sheets = useRef(new Map<number, HTMLDivElement>())
  const endMarker = useRef<HTMLDivElement>(null)

  const loadedEvent = useEffectEvent((count: number) => onLoaded(count))
  const failedEvent = useEffectEvent(() => onFailed())
  const pageEvent = useEffectEvent((page: number) => onPage(page))
  const reachedEndEvent = useEffectEvent(() => onReachedEnd())

  // Fetch the bytes and open them with pdf.js; read every page's size up front.
  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    void (async () => {
      try {
        const [response, pdfjs] = await Promise.all([fetch(url, { credentials: 'same-origin' }), import('unpdf/pdfjs')])
        if (!response.ok) throw new Error(`document answered ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        if (cancelled) return
        task = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: pdfjs.VerbosityLevel.ERRORS })
        const pdf = await task.promise
        const sizes: PageSize[] = []
        for (let number = 1; number <= pdf.numPages; number += 1) {
          const { width, height } = (await pdf.getPage(number)).getViewport({ scale: 1 })
          sizes.push({ width, height })
        }
        if (cancelled) return
        setLoaded({ kind: 'ready', pdf, sizes })
        loadedEvent(pdf.numPages)
      } catch {
        if (cancelled) return
        setLoaded({ kind: 'failed' })
        failedEvent()
      }
    })()
    return () => {
      cancelled = true
      // Destroying the loading task also destroys the document it opened.
      void task?.destroy()
    }
  }, [url])

  // Which sheets are near the viewport: draw them.
  const ready = loaded.kind === 'ready'
  useEffect(() => {
    if (!ready) return
    const pageOf = (entry: IntersectionObserverEntry) => Number((entry.target as HTMLElement).dataset.page)
    const observer = new IntersectionObserver(
      (entries) =>
        setNear((previous) => {
          const next = new Set(previous)
          for (const entry of entries) {
            if (entry.isIntersecting) next.add(pageOf(entry))
            else next.delete(pageOf(entry))
          }
          return next
        }),
      { rootMargin: NEAR_MARGIN },
    )
    for (const sheet of sheets.current.values()) observer.observe(sheet)
    return () => observer.disconnect()
  }, [ready])

  // The page the reader is on: the last sheet whose top has passed the middle
  // of the viewport. Read from the sheets' positions on every scroll (captured
  // on the window, so the dashboard panel's own scroll counts too), so a jump
  // to the end lands on the last page instead of the last one crossed.
  useEffect(() => {
    if (!ready) return
    let frame = 0
    const measure = () => {
      frame = 0
      const middle = window.innerHeight / 2
      let page = 1
      for (const [number, sheet] of sheets.current) {
        if (sheet.getBoundingClientRect().top <= middle) page = Math.max(page, number)
      }
      pageEvent(page)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ready])

  // The bottom of the last page on screen, once.
  useEffect(() => {
    const marker = endMarker.current
    if (!ready || endSeen || !marker) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setEndSeen(true)
      },
      { rootMargin: END_MARGIN },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [ready, endSeen])

  const pageCount = loaded.kind === 'ready' ? loaded.sizes.length : 0
  const lastDrawn = pageCount > 0 && drawn.has(pageCount)
  const reachedEnd = lastDrawn && (pageCount === 1 || endSeen)
  useEffect(() => {
    if (reachedEnd) reachedEndEvent()
  }, [reachedEnd])

  if (loaded.kind === 'loading') {
    return <Skeleton className="aspect-[210/297] w-full" />
  }

  if (loaded.kind === 'failed') {
    return (
      <div className="flex aspect-[210/297] w-full flex-col items-center justify-center gap-4 rounded-sm border border-border bg-background p-6 text-center">
        <p className="text-[13px] text-muted-foreground">{t('document_no_preview')}</p>
        <Button asChild variant="secondary">
          <a href={url} target="_blank" rel="noopener noreferrer" onClick={onOpened}>
            {t('open_document')}
          </a>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-6" data-ph-mask="">
      {loaded.sizes.map((size, index) => {
        const number = index + 1
        return (
          <div
            key={number}
            ref={(element) => {
              if (element) sheets.current.set(number, element)
              else sheets.current.delete(number)
            }}
            data-page={number}
            role="img"
            aria-label={t('page_label', { page: number, count: pageCount, file: fileName })}
            className="relative w-full overflow-hidden rounded-sm border border-border bg-white"
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
          >
            <PageCanvas
              pdf={loaded.pdf}
              number={number}
              pageWidth={size.width}
              active={near.has(number)}
              onDrawn={(isDrawn) =>
                setDrawn((previous) => {
                  if (previous.has(number) === isDrawn) return previous
                  const next = new Set(previous)
                  if (isDrawn) next.add(number)
                  else next.delete(number)
                  return next
                })
              }
            />
            {number === pageCount && <div ref={endMarker} aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px" />}
          </div>
        )
      })}
    </div>
  )
}

/**
 * One page's bitmap. Drawn into a fresh canvas at the sheet's width times the
 * device pixel ratio, swapped in when it is done (a redraw after a resize
 * never blanks the page), and emptied when the page leaves the window around
 * the viewport.
 */
function PageCanvas({
  pdf,
  number,
  pageWidth,
  active,
  onDrawn,
}: {
  pdf: PDFDocumentProxy
  number: number
  pageWidth: number
  active: boolean
  onDrawn: (drawn: boolean) => void
}) {
  const surface = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const drawnEvent = useEffectEvent((drawn: boolean) => onDrawn(drawn))

  // The sheet's width in CSS pixels; a resize settles before the page is drawn again.
  useEffect(() => {
    const element = surface.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let measured = false
    // The first notice arrives as observing starts: the width to draw at, at once.
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width)
      if (timer) clearTimeout(timer)
      if (!measured) {
        measured = true
        setWidth(next)
        return
      }
      timer = setTimeout(() => setWidth(next), RESIZE_SETTLE_MS)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const element = surface.current
    if (!element) return
    if (!active || width === 0) {
      release(element)
      drawnEvent(false)
      return
    }
    let cancelled = false
    let task: RenderTask | null = null
    void (async () => {
      const page = await pdf.getPage(number)
      if (cancelled) return
      const viewport = page.getViewport({ scale: (width / pageWidth) * (window.devicePixelRatio || 1) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.className = 'block h-full w-full'
      task = page.render({ canvas, viewport })
      await task.promise
      if (cancelled) return
      release(element)
      element.appendChild(canvas)
      drawnEvent(true)
    })().catch(() => {
      // A cancelled draw rejects; a page pdf.js cannot draw stays a blank sheet.
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [active, width, pdf, number, pageWidth])

  return <div ref={surface} className="absolute inset-0" />
}

/** Empty a sheet, giving its bitmap's memory back (a zero-size canvas frees it on iOS Safari). */
function release(element: HTMLDivElement) {
  for (const canvas of Array.from(element.querySelectorAll('canvas'))) {
    canvas.width = 0
    canvas.height = 0
  }
  element.replaceChildren()
}
