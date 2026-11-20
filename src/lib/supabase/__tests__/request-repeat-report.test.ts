import { beforeEach, describe, expect, it } from 'vitest'
import {
  REPEAT_REPORT_THRESHOLD,
  describeRepeatedRequest,
  reachesRepeatThreshold,
  resetRepeatReportForTests,
} from '../request-repeat-report'

beforeEach(() => {
  resetRepeatReportForTests()
})

describe('a request one session keeps repeating', () => {
  it('is reported once, on the request that reaches the threshold within a minute', () => {
    const start = 1_000_000
    const reports: number[] = []
    for (let i = 1; i <= REPEAT_REPORT_THRESHOLD * 2; i++) {
      if (reachesRepeatThreshold('user-1 GET /import', start + i * 100)) reports.push(i)
    }
    expect(reports).toEqual([REPEAT_REPORT_THRESHOLD])
  })

  it('is not reported at a poller pace, and counts each session and route apart', () => {
    const start = 1_000_000
    let reported = false
    // One request every 2 s for an hour.
    for (let i = 0; i < 1800; i++) reported ||= reachesRepeatThreshold('user-1 GET /api/import/sie/[id]', start + i * 2000)
    // Two sessions each just under the threshold in the same minute.
    for (let i = 1; i < REPEAT_REPORT_THRESHOLD; i++) {
      reported ||= reachesRepeatThreshold('user-2 GET /import', start + i)
      reported ||= reachesRepeatThreshold('user-3 GET /import', start + i)
    }
    expect(reported).toBe(false)
  })

  it('is reported again in a later minute if it is still going', () => {
    const start = 1_000_000
    let reports = 0
    for (let i = 0; i < 1200; i++) {
      if (reachesRepeatThreshold('user-1 GET /import', start + i * 111)) reports += 1
    }
    // 133 s at 9 a second: the threshold is reached in each of the two full minutes.
    expect(reports).toBe(2)
  })

  it('is described by what the browser says about it, with parameter names and no values', () => {
    const description = describeRepeatedRequest({
      method: 'GET',
      url: new URL('https://app.example.se/import?mode=sie&job=4d1a0f21&mode=bank'),
      headers: new Headers({
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        referer: 'https://app.example.se/settings/banking?select_accounts=secret',
        'user-agent': 'Mozilla/5.0',
      }),
    })

    expect(description).toMatchObject({
      method: 'GET',
      fetchDest: 'document',
      fetchMode: 'navigate',
      fetchSite: 'same-origin',
      refererPath: '/settings/banking',
      queryKeys: ['job', 'mode'],
      userAgent: 'Mozilla/5.0',
    })
    expect(JSON.stringify(description)).not.toContain('4d1a0f21')
    expect(JSON.stringify(description)).not.toContain('secret')
  })

  it('names a referring page by its route, never by a token in its path', () => {
    const description = describeRepeatedRequest({
      method: 'GET',
      url: new URL('https://app.example.se/api/invite/accept'),
      headers: new Headers({ referer: 'https://app.example.se/invite/3f9c1a7e5b2d4c6f8a0b1c2d3e4f5a6b' }),
    })
    expect(description.refererPath).toBe('/invite/*')
  })

  it('names only the origin of a page on another site', () => {
    const description = describeRepeatedRequest({
      method: 'GET',
      url: new URL('https://app.example.se/import'),
      headers: new Headers({ referer: 'https://other.example.com/some/path?q=1' }),
    })
    expect(description.refererPath).toBe('https://other.example.com')
  })
})
