import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * PDF -> page images for backends that cannot read PDF bytes natively (most
 * OpenAI-compatible endpoints: the OpenAI `file` content part is not part of
 * the de-facto chat-completions standard the Swedish providers implement).
 *
 * Uses poppler's `pdftoppm`, a system binary the self-host Docker image
 * installs (hosted runs Claude on Bedrock, which reads PDFs natively and
 * never needs this). A missing binary is a configuration state, not a crash:
 * callers stamp `skipped:pdf_rasterizer_missing` and move on.
 *
 * Rejected alternatives: pdfjs-dist + @napi-rs/canvas (two new npm
 * dependencies, memory spikes on large scans, dead weight on hosted).
 */

export type RasterizePdfResult =
  | { ok: true; pages: Buffer[]; mediaType: 'image/png'; pageCount: number }
  | { ok: false; reason: 'rasterizer_missing' | 'failed'; error?: string }

export interface RasterizePdfOptions {
  /** Pages rendered from the start of the document; invoice data sits on the first page(s). */
  maxPages: number
  /** Render resolution. 110 dpi keeps an A4 page under 1000x1300 px: readable, cheap in tokens. */
  dpi?: number
  /** Binary name or path; overridable for tests and unusual installs. */
  binary?: string
  timeoutMs?: number
}

const DEFAULT_DPI = 110
const DEFAULT_TIMEOUT_MS = 60_000

function pageNumberOf(fileName: string): number {
  // pdftoppm names pages <prefix>-1.png, <prefix>-01.png, <prefix>-001.png
  // depending on the page count's digit width. Sort by the numeric suffix.
  const match = /-(\d+)\.png$/.exec(fileName)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

export async function rasterizePdf(
  pdf: Buffer,
  opts: RasterizePdfOptions
): Promise<RasterizePdfResult> {
  const binary = opts.binary ?? process.env.AI_PDF_RASTERIZER_BIN ?? 'pdftoppm'
  const dpi = opts.dpi ?? DEFAULT_DPI
  const maxPages = Math.max(1, Math.floor(opts.maxPages))

  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'accounted-pdf-'))
    const input = join(dir, 'input.pdf')
    const prefix = join(dir, 'page')
    await writeFile(input, pdf)

    await execFileAsync(
      binary,
      ['-r', String(dpi), '-png', '-f', '1', '-l', String(maxPages), input, prefix],
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    )

    const names = (await readdir(dir))
      .filter((n) => n.startsWith('page-') && n.endsWith('.png'))
      .sort((a, b) => pageNumberOf(a) - pageNumberOf(b))
    if (names.length === 0) {
      return { ok: false, reason: 'failed', error: 'pdftoppm produced no pages' }
    }
    const pages: Buffer[] = []
    for (const name of names) pages.push(await readFile(join(dir, name)))
    return { ok: true, pages, mediaType: 'image/png', pageCount: pages.length }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'ENOENT') return { ok: false, reason: 'rasterizer_missing' }
    return {
      ok: false,
      reason: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
