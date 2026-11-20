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

  it('flags a body field put where it renders, which throws on a structured body', () => {
    expect(scan(`setNotice({ kind: 'error', text: result.error })`)).toEqual([1])
    expect(scan(`setError(json.error)`)).toEqual([1])
    expect(scan(`setError(body?.error ?? null)`)).toEqual([1])
    expect(scan(`return { ok: false, message: data.error }`)).toEqual([1])
  })

  it('flags the field destructured out of the response', () => {
    expect(scan(`const { error } = await res.json()`)).toEqual([1])
    expect(scan(`const { error: msg } = await chainRes.json()`)).toEqual([1])
  })

  it('leaves a domain result, a code read and a toast alone', () => {
    expect(scan(`setError(update.error)`)).toEqual([])
    expect(scan(`setSendError(outcome.error)`)).toEqual([])
    expect(scan(`setCode(json.error?.code)`)).toEqual([])
    expect(scan(`toast({ title: data.error, variant: 'destructive' })`)).toEqual([])
    expect(scan(`const { error: uploadError } = await storage.upload(path, file)`)).toEqual([])
    expect(scan(`setNotice({ text: typeof result.error === 'string' ? result.error : getErrorMessage(result) })`)).toEqual([])
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
