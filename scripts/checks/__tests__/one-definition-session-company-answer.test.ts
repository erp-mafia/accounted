/**
 * The session company guard catches a door that writes the no-company answer
 * by hand and leaves a door that asks resolveSessionCompany.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/session-company-answer.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('session-company-answer', () => {
  it.each([
    "return errorResponseFromCode('COMPANY_CONTEXT_MISSING', userLog, { requestId })",
    "return NextResponse.json({ error: { code: 'COMPANY_CONTEXT_MISSING' } }, { status: 400 })",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'const company = await resolveSessionCompany(supabase, user.id, resolved, log, requestId)',
    'if (!company.ok) return decorateResponse(company.response, requestId)',
    "// a door answers 'COMPANY_CONTEXT_MISSING' through resolveSessionCompany",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
