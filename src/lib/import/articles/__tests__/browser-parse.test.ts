import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { parseArticleFileInBrowser, ARTICLE_BROWSER_MAX_FILE_BYTES } from '../browser-parse'
import { ARTICLE_MATCH_MAX_ROWS } from '../types'

function xlsxFile(rows: (string | number)[][], name = 'prislista.xlsx'): File {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Artiklar')
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([bytes], name)
}

function matchResponse(matches: unknown[]) {
  return new Response(
    JSON.stringify({ data: { matches, duplicate_count: matches.filter((m) => m !== null).length } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('parseArticleFileInBrowser (crm#1383)', () => {
  it('parses in the browser and sends only the match keys', async () => {
    const file = xlsxFile([
      ['Artikelnummer', 'Benämning', 'Pris'],
      ['A-1', 'Skruv', '10'],
      ['A-2', 'Mutter', '5'],
    ])
    const fetchImpl = vi.fn(async () =>
      matchResponse([{ article_id: 'x', matched_by: 'article_number', existing_name: 'Skruv' }, null]),
    )

    const outcome = await parseArticleFileInBrowser(file, undefined, fetchImpl as unknown as typeof fetch)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.rows.map((r) => [r.article_number, r.price_excl_vat, r.duplicate_match?.article_id ?? null])).toEqual([
      ['A-1', 10, 'x'],
      ['A-2', 5, null],
    ])
    expect(outcome.result.duplicate_count).toBe(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/import/articles/match')
    expect(JSON.parse(String(init.body))).toEqual({
      rows: [
        { article_number: 'A-1', name: 'Skruv' },
        { article_number: 'A-2', name: 'Mutter' },
      ],
    })
  })

  it('matches a file larger than one batch in several calls', async () => {
    const rows: (string | number)[][] = [['Artikelnummer', 'Benämning']]
    for (let i = 0; i < ARTICLE_MATCH_MAX_ROWS + 5; i++) rows.push([`N-${i}`, `Artikel ${i}`])
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const n = (JSON.parse(String(init.body)) as { rows: unknown[] }).rows.length
      return matchResponse(Array.from({ length: n }, () => null))
    })

    const outcome = await parseArticleFileInBrowser(xlsxFile(rows), undefined, fetchImpl as unknown as typeof fetch)

    expect(outcome.ok && outcome.result.rows.length).toBe(ARTICLE_MATCH_MAX_ROWS + 5)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refuses a file over the browser ceiling without reading it', async () => {
    const big = { size: ARTICLE_BROWSER_MAX_FILE_BYTES + 1, name: 'x.csv' } as File
    const fetchImpl = vi.fn()
    expect(await parseArticleFileInBrowser(big, undefined, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a failed match with the route message, or none for a platform error', async () => {
    const file = xlsxFile([['Benämning'], ['Skruv']])
    const routeError = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message_sv: 'Kunde inte läsa artiklarna' } }), { status: 500 }),
    )
    expect(await parseArticleFileInBrowser(file, undefined, routeError as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'match_failed',
      message: 'Kunde inte läsa artiklarna',
    })
    const platform = vi.fn(async () => new Response('Request Entity Too Large', { status: 413 }))
    expect(await parseArticleFileInBrowser(file, undefined, platform as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: 'match_failed',
      message: null,
    })
  })
})
