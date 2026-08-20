import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeFile } from 'node:fs/promises'

// Fake pdftoppm: the module shells out with (-r dpi -png -f 1 -l N input prefix)
// and reads back <prefix>-<n>.png. The fake writes those files itself, so the
// read-back, ordering and cleanup paths run for real on a temp dir.
const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}))

import { rasterizePdf } from '../rasterize-pdf'

type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void

beforeEach(() => {
  vi.clearAllMocks()
})

describe('rasterizePdf', () => {
  it('renders the first pages in order and cleans up', async () => {
    execFileMock.mockImplementation((bin: string, args: string[], _opts: unknown, cb: Cb) => {
      expect(bin).toBe('pdftoppm')
      expect(args.slice(0, 6)).toEqual(['-r', '110', '-png', '-f', '1', '-l'])
      const prefix = args[args.length - 1]
      void (async () => {
        // Two pages, written out of order to prove numeric sorting.
        await writeFile(`${prefix}-2.png`, Buffer.from('PAGE2'))
        await writeFile(`${prefix}-1.png`, Buffer.from('PAGE1'))
        cb(null, { stdout: '', stderr: '' })
      })()
    })
    const result = await rasterizePdf(Buffer.from('%PDF'), { maxPages: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pageCount).toBe(2)
    expect(result.pages.map((p) => p.toString())).toEqual(['PAGE1', 'PAGE2'])
    expect(result.mediaType).toBe('image/png')
    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args[6]).toBe('4') // -l maxPages
  })

  it('reports a missing binary as rasterizer_missing', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Cb) => {
      const err = Object.assign(new Error('spawn pdftoppm ENOENT'), { code: 'ENOENT' })
      cb(err)
    })
    const result = await rasterizePdf(Buffer.from('%PDF'), { maxPages: 4 })
    expect(result).toEqual({ ok: false, reason: 'rasterizer_missing' })
  })

  it('reports any other failure as failed with the message', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Cb) => {
      cb(new Error('Syntax Error: Couldn\'t read xref table'))
    })
    const result = await rasterizePdf(Buffer.from('not a pdf'), { maxPages: 2 })
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
  })

  it('treats a run that produced no pages as failed', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: Cb) => {
      cb(null, { stdout: '', stderr: '' })
    })
    const result = await rasterizePdf(Buffer.from('%PDF'), { maxPages: 1 })
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
  })

  it('honours a binary override', async () => {
    execFileMock.mockImplementation((bin: string, _args: string[], _opts: unknown, cb: Cb) => {
      expect(bin).toBe('/opt/poppler/bin/pdftoppm')
      cb(new Error('x'))
    })
    await rasterizePdf(Buffer.from('%PDF'), { maxPages: 1, binary: '/opt/poppler/bin/pdftoppm' })
    expect(execFileMock).toHaveBeenCalled()
  })
})
