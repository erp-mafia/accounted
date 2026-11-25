/**
 * The default-team guard catches a door that looks up the owner's personal
 * team by hand and leaves a door that asks defaultTeamForNewCompany, and code
 * that only reads a team's kind.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/default-team-for-new-company.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('default-team-for-new-company', () => {
  it.each([
    "      .eq('teams.kind', 'personal')",
    "      .eq('team.kind', 'personal')",
    '  .eq("kind", "personal")',
    "  .filter('teams.kind', 'eq', 'personal')",
    "  .match({ 'teams.kind': 'personal' })",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'const teamId = parsed.data.team_id ?? (await defaultTeamForNewCompany(supabase, userId))',
    "const teamKind = myMembership.teams?.kind ?? 'personal'",
    "  .eq('teams.kind', 'byra')",
    "// the lookup filters .eq('teams.kind', 'personal')",
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
