/**
 * Proof that the hand-read-api-error guard catches a hand-rolled read of an
 * API error and leaves the reader, codes, conditions and comments alone.
 */
import { describe, it, expect } from 'vitest'
import { findHandReadErrorsInSource as scan } from '../hand-read-api-error.mjs'

describe('hand-read-api-error', () => {
  it('flags an error read with a translated or literal fallback', () => {
    expect(scan(`toast({ title: json.error || t('toast_create_failed') })`)).toEqual([1])
    expect(scan(`throw new Error(body.error ?? 'Kunde inte spara')`)).toEqual([1])
    expect(scan(`throw new Error(data.error?.message || tCommon('retry'))`)).toEqual([1])
    expect(scan('setError(json.error ?? `HTTP ${res.status}`)')).toEqual([1])
  })

  it('flags a typeof ternary, on one line or wrapped before its branch', () => {
    expect(scan(`const m = typeof body.error === 'string' ? body.error : body.error?.message`)).toEqual([1])
    expect(scan(`const m =\n  typeof json.error === 'string'\n    ? json.error\n    : t('x')`)).toEqual([2])
  })

  it('leaves the reader, code reads, conditions and comments alone', () => {
    expect(scan(`toast({ title: getErrorMessage(json, { locale: errorLocale, fallback: t('x') }) })`)).toEqual([])
    expect(scan(`setError(getUserErrorMessage(body?.error ?? body) || 'x')`)).toEqual([])
    expect(scan(`const code = result.error ?? ''`)).toEqual([])
    expect(scan(`if (!res.ok || json.error) return`)).toEqual([])
    expect(scan(` * The old \`throw new Error(json.error ?? '…')\` lost two things.`)).toEqual([])
    expect(scan(`// body.error || t('x') used to be here`)).toEqual([])
  })
})
