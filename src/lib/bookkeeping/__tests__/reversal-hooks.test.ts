/**
 * The ledger's reversal hook contract (../reversal-hooks.ts): selection and
 * the refusal when a required hook is missing, and how that refusal reaches
 * a person (Swedish, never the raw English) and an agent (a stable code).
 */
import { describe, expect, it } from 'vitest'
import {
  REVERSAL_MIRROR_REQUIRED,
  ReversalHookMissingError,
  selectReversalHooks,
  type ReversalHook,
} from '../reversal-hooks'
import { bookkeepingErrorResponse, isBookkeepingError, REVERSAL_HOOK_MISSING } from '../errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'

const hook = (id: string, sourceTypes: ReversalHook['sourceTypes']): ReversalHook => ({
  id,
  module: 'ledger',
  sourceTypes,
  afterReversal: async () => {},
})

describe('selectReversalHooks', () => {
  it('returns the hooks that cover the source type, in list order', () => {
    const a = hook('a', ['rot_rut_reclaim', 'manual'])
    const b = hook('b', ['invoice_paid'])
    const c = hook('c', ['manual'])
    expect(selectReversalHooks([a, b, c], 'manual')).toEqual([a, c])
    expect(selectReversalHooks([a, b, c], 'invoice_paid')).toEqual([b])
  })

  it('returns nothing for a source type that needs no mirror, or none at all', () => {
    expect(selectReversalHooks([], 'manual')).toEqual([])
    expect(selectReversalHooks([hook('a', ['invoice_paid'])], 'webshop_order')).toEqual([])
    expect(selectReversalHooks([], null)).toEqual([])
    expect(selectReversalHooks([], undefined)).toEqual([])
  })

  it.each(REVERSAL_MIRROR_REQUIRED)('refuses %s when no hook covers it', (sourceType) => {
    expect(() => selectReversalHooks([hook('other', ['manual'])], sourceType)).toThrow(ReversalHookMissingError)
    let caught: unknown
    try {
      selectReversalHooks([], sourceType)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ReversalHookMissingError)
    expect((caught as ReversalHookMissingError).sourceType).toBe(sourceType)
    expect((caught as ReversalHookMissingError).code).toBe(REVERSAL_HOOK_MISSING)
  })

  it('accepts a required source type covered by a hook with either phase', () => {
    const beforeOnly: ReversalHook = { id: 'b', module: 'invoicing', sourceTypes: ['rot_rut_reclaim'], beforeReversal: async () => {} }
    expect(selectReversalHooks([beforeOnly], 'rot_rut_reclaim')).toEqual([beforeOnly])
  })
})

describe('ReversalHookMissingError', () => {
  const err = new ReversalHookMissingError('rot_rut_reclaim')

  it('is a typed bookkeeping error answered as a 500 with its code and source type', async () => {
    expect(isBookkeepingError(err)).toBe(true)
    const res = bookkeepingErrorResponse(err)
    expect(res?.status).toBe(500)
    expect(await res?.json()).toEqual({
      error: { code: 'REVERSAL_HOOK_MISSING', message: err.message, details: { sourceType: 'rot_rut_reclaim' } },
    })
  })

  it('reaches a person in Swedish and an agent as a stable, non-retryable code', () => {
    const entry = getErrorEntry('REVERSAL_HOOK_MISSING')
    expect(entry?.httpStatus).toBe(500)
    expect(entry?.retryable).toBe(false)
    expect(getErrorMessage(err)).toBe(entry?.message_sv)
    expect(getErrorMessage(err)).toContain('Inget har bokförts')
    const structured = getStructuredError(err)
    expect(structured.code).toBe('REVERSAL_HOOK_MISSING')
    expect(structured.retryable).toBe(false)
    for (const text of [entry?.message_sv, entry?.message_en]) expect(text).not.toMatch(/[\u2013\u2014]/)
  })
})
