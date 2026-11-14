/**
 * Pinned previews (lib/operations/preview-token.ts): the canonicalizer and
 * the fingerprint. A token must be stable across everything that is not
 * meaning (key order, an undefined field, whitespace) and change with
 * everything that is (the preview, the input, the operation, the company),
 * so a commit can tell "the preview the person saw" from "what the books
 * would get now".
 */
import { describe, expect, it } from 'vitest'
import { ALL_OPERATIONS } from '../registry'
import {
  canonicalJson,
  computePreviewToken,
  isPreviewToken,
  operationPreviewToken,
  previewStaleFailure,
} from '../preview-token'

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const PREVIEW = {
  entry_date: '2026-10-15',
  lines: [
    { account_number: '6570', debit: 50, credit: 0 },
    { account_number: '1930', debit: 0, credit: 50 },
  ],
}
const INPUT = { transaction_id: 't-1', account_number: '6570' }

const token = (overrides: Partial<Parameters<typeof computePreviewToken>[0]> = {}) =>
  computePreviewToken({ operationId: 'transactions.categorize', companyId: COMPANY, input: INPUT, preview: PREVIEW, ...overrides })

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 2, x: 1 }], c: 'å' } })).toBe('{"a":{"c":"å","d":[{"x":1,"y":2}]},"b":1}')
  })

  it('is the same for the same value in any key order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('keeps array order: line order is meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('renders numbers as JSON does, never reformatted', () => {
    expect(canonicalJson({ amount: 50, rate: 0.25, total: 1234.5, negative: -0 })).toBe(
      '{"amount":50,"negative":0,"rate":0.25,"total":1234.5}',
    )
  })

  it('follows the wire: undefined drops from objects and is null in arrays, a Date is its JSON', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined, 1] })).toBe('{"b":null,"c":[null,1]}')
    expect(canonicalJson({ at: new Date('2026-10-15T10:00:00.000Z') })).toBe('{"at":"2026-10-15T10:00:00.000Z"}')
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('computePreviewToken', () => {
  it('is pv1. followed by a base64url SHA-256, the shape isPreviewToken accepts', () => {
    expect(token()).toMatch(/^pv1\.[A-Za-z0-9_-]{43}$/)
    expect(isPreviewToken(token())).toBe(true)
    expect(isPreviewToken('pv1.short')).toBe(false)
    expect(isPreviewToken('pv2.' + token().slice(4))).toBe(false)
    expect(isPreviewToken('')).toBe(false)
  })

  it('is stable across calls and across key order of the input and the preview', () => {
    const reordered = computePreviewToken({
      companyId: COMPANY,
      preview: { lines: PREVIEW.lines.map((l) => ({ credit: l.credit, debit: l.debit, account_number: l.account_number })), entry_date: '2026-10-15' },
      input: { account_number: '6570', transaction_id: 't-1' },
      operationId: 'transactions.categorize',
    })
    expect(token()).toBe(token())
    expect(reordered).toBe(token())
  })

  it('changes when the preview changes: an amount, an account, a date, a line', () => {
    const base = token()
    const changed = [
      { ...PREVIEW, lines: [{ ...PREVIEW.lines[0], debit: 51 }, PREVIEW.lines[1]] },
      { ...PREVIEW, lines: [{ ...PREVIEW.lines[0], account_number: '6540' }, PREVIEW.lines[1]] },
      { ...PREVIEW, entry_date: '2026-10-16' },
      { ...PREVIEW, lines: [...PREVIEW.lines, { account_number: '2641', debit: 0, credit: 0 }] },
    ]
    for (const preview of changed) expect(token({ preview })).not.toBe(base)
  })

  it('binds the operation, the company and the input', () => {
    const base = token()
    expect(token({ operationId: 'transactions.uncategorize' })).not.toBe(base)
    expect(token({ companyId: OTHER_COMPANY })).not.toBe(base)
    expect(token({ input: { ...INPUT, account_number: '6540' } })).not.toBe(base)
  })

  it('reads the company id case-insensitively, as a uuid is', () => {
    expect(token({ companyId: COMPANY.toUpperCase() })).toBe(token())
  })

  it('leaves out only the top-level volatile keys it is given', () => {
    const at = (signed_at: string) => ({ status_after: 'signed', signed_at, nested: { signed_at } })
    const pinned = (preview: Record<string, unknown>) => token({ preview, volatileKeys: ['signed_at'] })
    // A top-level signed_at that moves on every call does not unpin...
    expect(pinned({ status_after: 'signed', signed_at: '2026-10-15T10:00:00Z' })).toBe(
      pinned({ status_after: 'signed', signed_at: '2026-10-15T10:00:07Z' }),
    )
    // ...but the same name deeper in the preview stays pinned.
    expect(pinned(at('2026-10-15T10:00:00Z'))).not.toBe(pinned(at('2026-10-15T10:00:07Z')))
  })

  it('encodes nothing of the input: the token is a digest, not the input in disguise', () => {
    const t = token({ input: { personal_number: '19121212-1212', account_number: '6570' } })
    expect(t).not.toContain('1212')
    expect(Buffer.from(t.slice(4), 'base64url')).toHaveLength(32)
  })
})

describe('operationPreviewToken', () => {
  it('uses the operation id and its own volatile keys', () => {
    const op = { id: 'arsredovisning.record-signature', volatilePreviewKeys: ['signed_at'] as const }
    const preview = { status_after: 'signed', signed_at: '2026-10-15T10:00:00Z' }
    expect(operationPreviewToken(op, COMPANY, INPUT, preview)).toBe(
      computePreviewToken({ operationId: op.id, companyId: COMPANY, input: INPUT, preview, volatileKeys: ['signed_at'] }),
    )
  })

  it('the excluded list is exactly the one the module documents: a new entry is a reviewed change', () => {
    const declared = Object.fromEntries(
      ALL_OPERATIONS.filter((op) => op.volatilePreviewKeys && op.volatilePreviewKeys.length > 0).map((op) => [
        op.id,
        [...op.volatilePreviewKeys!],
      ]),
    )
    expect(declared).toEqual({
      'arsredovisning.record-signature': ['signed_at'],
      'suppliers.archive': ['archived_at'],
    })
  })
})

describe('previewStaleFailure', () => {
  it('is PREVIEW_STALE carrying the fresh preview and its token', () => {
    expect(previewStaleFailure(PREVIEW, token())).toEqual({
      ok: false,
      code: 'PREVIEW_STALE',
      details: { preview: PREVIEW, preview_token: token() },
    })
  })
})
