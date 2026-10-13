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
