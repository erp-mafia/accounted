import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VERIFIKAT_LIST_QUERY,
  readVerifikatListQuery,
  writeVerifikatListQuery,
  type VerifikatListQuery,
} from '../verifikat-list-query'

/**
 * The verifikat list keeps its view in the address of /bookkeeping
 * (crm#1998): the filters, the search and the page came back empty after
 * opening a verifikat and pressing Back, because they lived only in the
 * list's component state.
 */
const PERIOD = '11111111-2222-3333-4444-555555555555'

const read = (query: string) => readVerifikatListQuery(new URLSearchParams(query))

const view = (patch: Partial<VerifikatListQuery>): VerifikatListQuery => ({
  ...DEFAULT_VERIFIKAT_LIST_QUERY,
  ...patch,
})

describe('readVerifikatListQuery', () => {
  it('reads plain /bookkeeping as the default view', () => {
    expect(read('')).toEqual(DEFAULT_VERIFIKAT_LIST_QUERY)
  })

  it('reads every key of the view', () => {
    expect(
      read(`series=B&from=2026-01-01&to=2026-03-31&q=hyra&corrections=hide&missing=true&scope=${PERIOD}&page=3`),
    ).toEqual({
      mode: 'committed',
      series: 'B',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
      search: 'hyra',
      correctionView: 'hide',
      missingOnly: true,
      visitScope: { periodId: PERIOD },
      page: 2,
    })
    expect(read('status=draft').mode).toBe('drafts')
    expect(read('scope=all').visitScope).toEqual({ periodId: null })
    expect(read('corrections=all').correctionView).toBe('all')
  })

  it('leaves what it cannot read at the default', () => {
    expect(
      read('status=posted&series=AB&from=2026-02-31&to=31/03/2026&corrections=x&missing=1&scope=nope&page=0'),
    ).toEqual(DEFAULT_VERIFIKAT_LIST_QUERY)
    expect(read('series=1').series).toBeNull()
    expect(read('page=-2').page).toBe(0)
    expect(read('page=2.5').page).toBe(0)
  })

  it('never reads the saknade-underlag filter into the Utkast view', () => {
    expect(read('status=draft&missing=true').missingOnly).toBe(false)
  })

  it('takes a lower-case series letter as the letter', () => {
    expect(read('series=k').series).toBe('K')
  })

  it('trims the search text', () => {
    expect(read('q=%20%20hyra%20').search).toBe('hyra')
  })

  it("reads Hem's link (missingUnderlag=true) as the filter over all years", () => {
    expect(read('missingUnderlag=true')).toEqual(view({ missingOnly: true, visitScope: { periodId: null } }))
  })

  it("reads the bokslut preflight's link (gaps=<id>) as a visit on that year", () => {
    expect(read(`gaps=${PERIOD}`)).toEqual(view({ visitScope: { periodId: PERIOD } }))
    expect(read('gaps=not-a-uuid').visitScope).toBeNull()
  })

  it('lets the written scope win over an arrival key', () => {
    expect(read(`missingUnderlag=true&scope=${PERIOD}`).visitScope).toEqual({ periodId: PERIOD })
    expect(read(`gaps=${PERIOD}&scope=all`).visitScope).toEqual({ periodId: null })
  })

  it('reads the filter turned on inside the list without widening the year', () => {
    expect(read('missing=true')).toEqual(view({ missingOnly: true }))
  })
})

describe('writeVerifikatListQuery', () => {
  it('writes nothing for the default view', () => {
    expect(writeVerifikatListQuery('', DEFAULT_VERIFIKAT_LIST_QUERY).toString()).toBe('')
  })

  it('writes each part of the view under its key, the page 1-based', () => {
    const written = writeVerifikatListQuery(
      '',
      view({
        mode: 'drafts',
        series: 'D',
        dateFrom: '2026-01-01',
        dateTo: '2026-06-30',
        search: 'el och vatten',
        correctionView: 'all',
        missingOnly: true,
        visitScope: { periodId: null },
        page: 4,
      }),
    )
    expect(Object.fromEntries(written)).toEqual({
      status: 'draft',
      series: 'D',
      from: '2026-01-01',
      to: '2026-06-30',
      q: 'el och vatten',
      corrections: 'all',
      missing: 'true',
      scope: 'all',
      page: '5',
    })
  })

  it('keeps parameters that are not the list view', () => {
    const written = writeVerifikatListQuery('copy_from=abc&series=A', view({ series: 'B' }))
    expect(written.get('copy_from')).toBe('abc')
    expect(written.getAll('series')).toEqual(['B'])
  })

  it('drops a filter that was cleared', () => {
    expect(writeVerifikatListQuery('series=B&q=hyra&page=2', DEFAULT_VERIFIKAT_LIST_QUERY).toString()).toBe('')
  })

  it('replaces the arrival keys with the keys the list reads back the same way', () => {
    const arrived = read('missingUnderlag=true')
    const written = writeVerifikatListQuery('missingUnderlag=true', arrived)
    expect(written.has('missingUnderlag')).toBe(false)
    expect(read(written.toString())).toEqual(arrived)

    // The filter turned off again while the all-years visit lasts: the
    // address keeps the visit, not the filter.
    const off = writeVerifikatListQuery(written, { ...arrived, missingOnly: false })
    expect(read(off.toString())).toEqual(view({ visitScope: { periodId: null } }))
  })

  it('round-trips every view through the address', () => {
    const views: VerifikatListQuery[] = [
      DEFAULT_VERIFIKAT_LIST_QUERY,
      view({ series: 'K', page: 1 }),
      view({ mode: 'drafts', search: 'faktura 1042' }),
      view({ dateFrom: '2025-07-01', correctionView: 'hide', visitScope: { periodId: PERIOD } }),
      view({ missingOnly: true, visitScope: null }),
    ]
    for (const v of views) {
      expect(read(writeVerifikatListQuery('', v).toString())).toEqual(v)
    }
  })
})
