import { NextResponse } from 'next/server'
import { contentDisposition } from '@/lib/api/content-disposition'

export interface FileResponseOptions {
  /** Name the browser saves (or shows) the file under; any Unicode is safe here. */
  filename: string
  contentType: string
  /** 'attachment' (default) saves the file; 'inline' lets the browser show it. */
  disposition?: 'attachment' | 'inline'
  /** Set only when given: most exports leave caching to the platform default. */
  cacheControl?: string
  /** Any further headers the route answers with. */
  headers?: Record<string, string>
}

/**
 * The answer of a route that returns a file (a report PDF or XLSX, an SIE
 * file, a payment file, an archive). The Content-Disposition header goes
 * through contentDisposition(), which encodes the name as RFC 6266/5987
 * expect: a raw `filename="${name}"` throws inside undici for any character
 * above U+00FF and breaks the header on a quote, turning the export into a
 * 500.
 */
export function fileResponse(body: BodyInit, options: FileResponseOptions): NextResponse {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType,
    'Content-Disposition': contentDisposition(options.disposition ?? 'attachment', options.filename),
    ...(options.cacheControl ? { 'Cache-Control': options.cacheControl } : {}),
    ...options.headers,
  }
  return new NextResponse(body, { status: 200, headers })
}

export interface StreamedBodyHooks {
  /** The last byte went out. */
  onEnd?: (bytes: number) => void
  /** The source failed part way: the response is cut off and the client sees a failed download. */
  onError?: (error: unknown, bytes: number) => void
  /** The client went away before the end. */
  onCancel?: (bytes: number) => void
}

/**
 * A response body read from `chunks` only as fast as the client takes it,
 * for a file too large to build in memory first (the complete archive). The
 * next chunk is asked for once the previous one has been handed on, so a slow
 * client holds the source back instead of filling memory, and a client that
 * leaves ends the source.
 */
export function streamedBody(
  chunks: AsyncIterable<Uint8Array>,
  hooks: StreamedBodyHooks = {},
): ReadableStream<Uint8Array> {
  const source = chunks[Symbol.asyncIterator]()
  let bytes = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await source.next()
        if (next.done) {
          controller.close()
          hooks.onEnd?.(bytes)
          return
        }
        bytes += next.value.byteLength
        controller.enqueue(next.value)
      } catch (error) {
        hooks.onError?.(error, bytes)
        controller.error(error)
      }
    },
    async cancel() {
      hooks.onCancel?.(bytes)
      await source.return?.(undefined)
    },
  })
}
