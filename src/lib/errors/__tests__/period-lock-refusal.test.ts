/**
 * The database's lock refusals are plain text (triggers are never edited),
 * so they are read in one table (DATABASE_REFUSALS). Routes and services ask
 * isPeriodLockRefusal / isLockDateRefusal instead of matching the sentences
 * themselves, and classifyError answers PERIOD_LOCKED for every one of them,
 * except a document on a verifikat in a locked year: DOC_UPLOAD_PERIOD_LOCKED.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { NextResponse } from 'next/server'
import {
  classifyError,
  errorResponse,
  getStructuredError,
  isLockDateRefusal,
  isPeriodLockRefusal,
} from '../get-structured-error'
import { getErrorMessage } from '../get-error-message'
import { getErrorEntry } from '../structured-errors'
import { databaseRefusal } from '../database-refusal'

const PERIOD = { code: 'P0001', message: 'Cannot write to locked/closed fiscal period "2025" (is_closed=t, locked_at=2026-01-31)' }
const LOCK_DATE = new Error('Bokföringen är låst t.o.m. 2025-12-31. Ändringar före detta datum kan inte göras.')
const TAX_ADJUSTMENTS = { code: 'P0001', message: 'Fiscal period is locked for tax adjustments' }
const TAX_ELECTIONS = { code: 'P0001', message: 'Fiscal period is locked for tax depreciation elections' }

// enforce_period_lock_documents (migration 017), as each document door's
// service wraps it.
const DOCUMENT_TRIGGER = 'Cannot attach documents to entries in a locked/closed fiscal period'
const DOCUMENT_REFUSALS = [
  { code: 'P0001', message: DOCUMENT_TRIGGER },
  Object.assign(new Error(`Failed to create document record: ${DOCUMENT_TRIGGER}`), { code: 'P0001' }),
  new Error(`Failed to create document record: ${DOCUMENT_TRIGGER}`),
  new Error(`Failed to link document: ${DOCUMENT_TRIGGER}`),
  new Error(`Failed to create new version: ${DOCUMENT_TRIGGER}`),
]

const silent = { error: () => {}, warn: () => {} }

describe('database lock refusals', () => {
  it.each([PERIOD, LOCK_DATE, TAX_ADJUSTMENTS, TAX_ELECTIONS])('classifies %o as PERIOD_LOCKED', (error) => {
    expect(classifyError(error).code).toBe('PERIOD_LOCKED')
    expect(isPeriodLockRefusal(error)).toBe(true)
  })

  it('reads a bare message as well as an error', () => {
    expect(isPeriodLockRefusal(PERIOD.message)).toBe(true)
    expect(isPeriodLockRefusal(DOCUMENT_TRIGGER)).toBe(true)
    expect(isPeriodLockRefusal(null)).toBe(false)
    expect(isPeriodLockRefusal(undefined)).toBe(false)
  })

  it('tells the company lock date apart from a period lock', () => {
    expect(isLockDateRefusal(LOCK_DATE)).toBe(true)
    expect(isLockDateRefusal(PERIOD)).toBe(false)
    expect(isLockDateRefusal(TAX_ADJUSTMENTS)).toBe(false)
    expect(isLockDateRefusal(DOCUMENT_REFUSALS[0])).toBe(false)
  })

  it('is false for any other failure', () => {
    expect(isPeriodLockRefusal(new Error('duplicate key value violates unique constraint'))).toBe(false)
    expect(isPeriodLockRefusal({ code: '42501', message: 'permission denied' })).toBe(false)
  })
})

describe('a document on a verifikat in a locked or closed year', () => {
  const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!

  it.each(DOCUMENT_REFUSALS)('is DOC_UPLOAD_PERIOD_LOCKED at every door: %o', async (error) => {
    expect(isPeriodLockRefusal(error)).toBe(true)
    expect(classifyError(error)).toEqual({ code: 'DOC_UPLOAD_PERIOD_LOCKED', transient: false })

    // REST (and v1 through it): a 400 with the registry's sentences and next step.
    const res: NextResponse = errorResponse(error, silent, { requestId: 'req-1' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatchObject({
      code: 'DOC_UPLOAD_PERIOD_LOCKED',
      message: answer.message_sv,
      message_en: answer.message_en,
      remediation: answer.remediation,
    })

    // MCP: the same code and Swedish sentence, never retryable.
    expect(getStructuredError(error)).toMatchObject({
      code: 'DOC_UPLOAD_PERIOD_LOCKED',
      message_sv: answer.message_sv,
      retryable: false,
    })

    // The UI's reading of a raw error: the same sentence, not the one about
    // creating a verifikat that the generic lock pattern gives.
    expect(getErrorMessage(error)).toBe(answer.message_sv)
  })

  it('says why and the way forward the product offers', () => {
    expect(answer.httpStatus).toBe(400)
    expect(answer.message_sv).toContain('låst eller stängt räkenskapsår')
    expect(answer.message_sv).toContain('Inställningar → Bokföring → Räkenskapsår')
    // True for a file refused at upload and for one already stored (a link, an attach).
    expect(answer.message_sv).toContain('kan filen ändå sparas, utan koppling till verifikationen')
    // The Dokument section is not shown to every company (lib/arkiv/flag.ts).
    expect(answer.message_sv).not.toContain('Dokument')
    expect(answer.message_en).toContain('Settings → Bookkeeping → Fiscal years')
    expect(answer.remediation?.description).toMatch(/gnubok_unlock_period[\s\S]*gnubok_reopen_fiscal_period_external/)
    // v1 caches a 4xx under its Idempotency-Key: the retry after unlocking needs a new one.
    expect(answer.remediation?.description).toContain('with a new Idempotency-Key')
    expect(answer.remediation?.tool).toBe('gnubok_list_fiscal_periods')
  })

  it('ends the upload and link doors\' next step with keeping the file unlinked', () => {
    expect(answer.remediation?.description).toMatch(
      /lock or close the year again\. A year that stays closed: the file is kept unlinked\. Send an upload again without journal_entry_id; a document that is already stored stays as it is \(GET \/documents\?linked=false lists both\)\.$/,
    )
  })

  it('is the answer a bank-row attach gives when only the pin could be saved, with attach-document\'s own last step', () => {
    const attach = getErrorEntry('DOC_ATTACH_PERIOD_LOCKED')!
    expect(attach.message_sv).toContain(answer.message_sv)
    expect(attach.message_en).toContain(answer.message_en)
    // The same way out of the year, then the attach's own case: the document
    // is already stored, so no advice to upload it again (#248).
    const upload = answer.remediation!.description
    const wayOut = upload.slice(0, upload.indexOf(' A year that stays closed:'))
    expect(attach.remediation?.description.startsWith(`${wayOut} A year that stays closed:`)).toBe(true)
    expect(attach.remediation?.description).toContain('the document is already stored and stays as it is')
    expect(attach.remediation?.description).not.toMatch(/upload again|journal_entry_id/)
    expect(attach.remediation?.tool).toBe(answer.remediation?.tool)
  })

  it('leaves a verifikat refused in a locked period as PERIOD_LOCKED', () => {
    expect(getErrorMessage(PERIOD)).not.toBe(answer.message_sv)
  })
})

// The posting functions check the lock themselves before they commit, in
// their own words, and the engine carries most of those refusals as a
// BookkeepingDatabaseError: one the reader does not read answers a retryable
// 500. Read from each function's newest definition, so a later migration
// that words a refusal of a locked or closed fiscal period, or of the lock
// date, anew fails here until the reader (lib/errors/database-refusal.ts)
// reads it, or the function raises a code.
describe('every lock refusal a posting function raises is read as a lock', () => {
  const dir = resolve(__dirname, '../../../../supabase/migrations')
  const newest = new Map<string, string>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(resolve(dir, file), 'utf8')
    for (const created of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\(/gi)) {
      const rest = sql.slice(created.index)
      const open = /\bAS\s+(\$\w*\$)/i.exec(rest)
      if (!open) continue
      const start = open.index + open[0].length
      newest.set(created[1], rest.slice(start, rest.indexOf(open[1], start)))
    }
  }
  const postingFunctions = [...newest.keys()]
    .filter((name) => name.startsWith('commit_') || name === 'split_asset_at_k3_transition')
    .map((name) => ({
      name,
      sentences: [...newest.get(name)!.matchAll(/RAISE EXCEPTION '([^']*)'/g)]
        .map(([, sentence]) => sentence)
        // A lock of a fiscal period, or the company lock date: not every
        // sentence that says "closed" (an invoice, a case) is one.
        .filter((sentence) => /\b(locked|closed)\b.*\bfiscal (period|year)\b|\blocked through\b/i.test(sentence)),
    }))
    .filter(({ sentences }) => sentences.length > 0)

  it('finds the functions that check the lock themselves', () => {
    expect(postingFunctions.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'commit_asset_disposal',
        'commit_asset_component_replacement',
        'commit_asset_value_adjustment',
        'commit_deferred_tax',
        'commit_contract_revenue',
        'commit_k3_transition',
        'commit_opening_balance_replacement',
        'split_asset_at_k3_transition',
      ]),
    )
  })

  it.each(postingFunctions)('$name', ({ sentences }) => {
    for (const sentence of sentences) {
      const raised = sentence.replaceAll('%', '2025-12-31')
      expect(databaseRefusal(raised), raised).toMatchObject({ code: 'PERIOD_LOCKED' })
      expect(isLockDateRefusal(raised), raised).toBe(/locked through/i.test(raised))
    }
  })
})
