import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { parseArticleFileInBrowser, ARTICLE_BROWSER_MAX_FILE_BYTES } from '../browser-parse'
import { ARTICLE_MATCH_MAX_BYTES, ARTICLE_MATCH_MAX_ROWS } from '../types'

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

  it('re-importing a price list with long names keeps every match call and answer under the hosted limit (#187)', async () => {
    // Every row matches an existing article, so every answer carries a full
    // match with the article's name: the largest answer the route gives.
    const name = (i: number) => `Kopplingsdosa infälld för gips, vit, med lock och skruvar, förpackning om 25 st, artikel nummer ${i} `.padEnd(130, 'ö')
    const rows: (string | number)[][] = [['Artikelnummer', 'Benämning']]
    for (let i = 0; i < ARTICLE_MATCH_MAX_ROWS; i++) rows.push([`EL-${1_000_000 + i}`, name(i)])
    const encoder = new TextEncoder()
    const requestBytes: number[] = []
    const answerBytes: number[] = []
    let seen = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body)
      requestBytes.push(encoder.encode(body).length)
      const keys = (JSON.parse(body) as { rows: { name: string }[] }).rows
      const matches = keys.map((k, j) => ({
        article_id: `00000000-0000-4000-8000-${String(seen + j).padStart(12, '0')}`,
        matched_by: 'article_number',
        existing_name: k.name,
      }))
      seen += keys.length
      const answer = JSON.stringify({ data: { matches, duplicate_count: matches.length } })
      answerBytes.push(encoder.encode(answer).length)
      return new Response(answer, { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const outcome = await parseArticleFileInBrowser(xlsxFile(rows), undefined, fetchImpl as unknown as typeof fetch)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // One call by count alone would answer about 4.8 MB, past the 4.5 MB the host carries.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1)
    for (const b of requestBytes) expect(b).toBeLessThanOrEqual(ARTICLE_MATCH_MAX_BYTES + 16)
    for (const b of answerBytes) expect(b).toBeLessThan(4_500_000)
    // The answers line up with the rows across the calls.
    expect(outcome.result.duplicate_count).toBe(ARTICLE_MATCH_MAX_ROWS)
    const last = outcome.result.rows[ARTICLE_MATCH_MAX_ROWS - 1]
    expect(last.article_number).toBe(`EL-${1_000_000 + ARTICLE_MATCH_MAX_ROWS - 1}`)
    expect(last.duplicate_match?.article_id).toBe(`00000000-0000-4000-8000-${String(ARTICLE_MATCH_MAX_ROWS - 1).padStart(12, '0')}`)
  }, 30_000)

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
