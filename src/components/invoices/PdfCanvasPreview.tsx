'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'unpdf/pdfjs'
import { Skeleton } from '@/components/ui/skeleton'
import { drawsPdfInPage } from '@/lib/browser/pdf-embed'
import { cn } from '@/lib/utils'

/** A resize redraws the pages at their new size once it has settled. */
const RESIZE_SETTLE_MS = 150
/** Sharp on a retina screen; more only costs memory (a phone caps canvas memory). */
const MAX_PIXEL_RATIO = 2

interface PageSize {
  width: number
  height: number
}

const noSubscribe = () => () => {}

/**
 * True where the PDF previews draw the PDF themselves (lib/browser/pdf-embed).
 * False on the server and during hydration, so the first client render
 * matches the server's; the real answer follows right after.
 */
export function useDrawsPdfInPage(): boolean {
  return useSyncExternalStore(noSubscribe, () => drawsPdfInPage(), () => false)
}

interface PdfCanvasPreviewProps {
  /** The PDF (a blob: URL from the preview route); a #fragment of viewer options is ignored. */
  url: string
  /** 'page': each page fitted inside the box. 'width': each page as wide as the box, scrolling down. */
  fit: 'page' | 'width'
  /** The accessible name of the preview. */
  title: string
  /** The box the preview fills (position and size); it scrolls inside. */
  className?: string
  /** Shown instead of the pages when pdf.js cannot open the file. */
  fallback?: ReactNode
}

/**
 * The invoice PDF drawn by us, page by page, for the browsers that leave an
 * `<object type="application/pdf">` with a blob: URL blank (Safari, every
 * browser on iOS: crm#1689). pdf.js through unpdf's serverless build
 * (`unpdf/pdfjs`, no worker), the renderer the signing page already uses on
 * those browsers (components/signing/SigningDocument.tsx), loaded only when
 * a preview mounts here.
 *
 * Every render draws all pages into fresh canvases and swaps them in when
 * they are done, so an edit (a new blob URL) or a resize never blanks the
 * page: the previous drawing stays until the next one is ready.
 */
export function PdfCanvasPreview({ url, fit, title, className, fallback }: PdfCanvasPreviewProps) {
  const box = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<{ pdf: PDFDocumentProxy; sizes: PageSize[] } | null>(null)
  const [failed, setFailed] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const [area, setArea] = useState<PageSize>({ width: 0, height: 0 })
  const source = url.split('#')[0]

  // Fetch the bytes and open them with pdf.js; read every page's size up front.
  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    void (async () => {
      try {
        const [response, pdfjs] = await Promise.all([fetch(source), import('unpdf/pdfjs')])
        if (!response.ok) throw new Error(`preview answered ${response.status}`)
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
        setFailed(false)
        setDoc({ pdf, sizes })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      // Destroying the loading task also destroys the document it opened;
      // the canvases already drawn from it stay on screen.
      void task?.destroy()
    }
  }, [source])

  // The box's size; a resize settles before the pages are drawn again.
  useEffect(() => {
    const element = box.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let measured = false
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }
      if (timer) clearTimeout(timer)
      if (!measured) {
        measured = true
        setArea(next)
        return
      }
      timer = setTimeout(() => setArea(next), RESIZE_SETTLE_MS)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Draw every page into new canvases, then swap them in at once.
  useEffect(() => {
    const target = sheet.current
    if (!doc || !target || area.width === 0) return
    let cancelled = false
    let task: RenderTask | null = null
    const canvases: HTMLCanvasElement[] = []
    void (async () => {
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
      for (const [index, size] of doc.sizes.entries()) {
        const scale =
          fit === 'page' && area.height > 0
            ? Math.min(area.width / size.width, area.height / size.height)
            : area.width / size.width
        const page = await doc.pdf.getPage(index + 1)
        if (cancelled) return
        const viewport = page.getViewport({ scale: scale * ratio })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(size.width * scale)}px`
        canvas.style.height = `${Math.floor(size.height * scale)}px`
        canvas.className = 'mx-auto block shrink-0 rounded-lg border border-border'
        canvases.push(canvas)
        task = page.render({ canvas, viewport })
        await task.promise
        if (cancelled) return
      }
      const previous = Array.from(target.querySelectorAll('canvas'))
      target.replaceChildren(...canvases)
      release(previous)
      setDrawn(true)
    })().catch(() => {
      // A cancelled draw rejects. A page pdf.js cannot draw keeps the
      // previous drawing, or shows the fallback when there is none.
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
      task?.cancel()
      // Canvases this run drew but never showed give their memory back.
      release(canvases.filter((canvas) => !canvas.isConnected))
    }
  }, [doc, area, fit])

  return (
    <div ref={box} role="img" aria-label={title} data-ph-mask="" className={cn('relative overflow-y-auto', className)}>
      <div ref={sheet} className="flex flex-col gap-3" />
      {failed && !drawn
        ? fallback
        : !drawn && <Skeleton className="absolute inset-0 h-full w-full rounded-lg" />}
    </div>
  )
}

/** Empty canvases, giving their bitmaps' memory back (a zero-size canvas frees it on iOS Safari). */
function release(canvases: HTMLCanvasElement[]) {
  for (const canvas of canvases) {
    canvas.width = 0
    canvas.height = 0
    canvas.remove()
  }
}
