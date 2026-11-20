import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@/lib/logger'
import { listErrorCodes } from '@/lib/errors/structured-errors'
import { ERROR_CATALOGUE_URL, ERROR_CODE_SEGMENT, docsUrlFor } from '../error-docs'
import { v1ErrorResponseFromCode } from '../errors'

/**
 * `docs_url` is the code's anchor in the one error catalogue page: the
 * catalogue's entry headings have the code in lowercase as their id. Until
 * 2026-11 it was `/docs/api/errors/<CODE>`, a page per code the docs site
 * never had (404).
 */

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

describe('docsUrlFor', () => {
  it.each([
    ['PERIOD_LOCKED', 'https://docs.accounted.se/errors#period_locked'],
    ['DOC_ATTACH_PERIOD_LOCKED', 'https://docs.accounted.se/errors#doc_attach_period_locked'],
    ['INTERNAL_ERROR', 'https://docs.accounted.se/errors#internal_error'],
    ['VALIDATION_ERROR', 'https://docs.accounted.se/errors#validation_error'],
  ])('%s links the catalogue entry %s', (code, url) => {
    expect(docsUrlFor(code)).toBe(url)
  })

  it('is the catalogue page with an anchor, never a page per code', () => {
    const url = new URL(docsUrlFor('PERIOD_LOCKED'))
    expect(`${url.origin}${url.pathname}`).toBe(ERROR_CATALOGUE_URL)
    expect(url.hash).toBe('#period_locked')
  })

  it('every registry code fits the code segment the old per-code address is forwarded for', () => {
    const segment = new RegExp(`^${ERROR_CODE_SEGMENT}$`)
    const misfits = listErrorCodes().filter((code) => !segment.test(code))
    expect(misfits).toEqual([])
  })
})

describe('the v1 error envelope', () => {
  it('carries the anchor as docs_url', async () => {
    const res = await v1ErrorResponseFromCode('PERIOD_LOCKED', log, { requestId: 'req_test' })
    const body = (await res.json()) as { error: { code: string; docs_url?: string } }
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.docs_url).toBe('https://docs.accounted.se/errors#period_locked')
  })
})
