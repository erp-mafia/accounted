/**
 * The grantable roles guard catches the four roles written out as a list,
 * in any order, and leaves a list that names owner or reads the definition.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/grantable-company-roles.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('grantable-company-roles', () => {
  it.each([
    "  role: z.enum(['admin', 'member', 'viewer', 'invoicer']).default('viewer'),",
    "const ROLES = ['viewer', 'invoicer', 'member', 'admin'] as const",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    "const ROLES = ['owner', 'admin', 'member', 'viewer', 'invoicer'] as const",
    '  role: z.enum(GRANTABLE_COMPANY_ROLES).default(\'viewer\'),',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
