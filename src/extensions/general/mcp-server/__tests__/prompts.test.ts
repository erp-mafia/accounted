import { describe, it, expect } from 'vitest'
import { prompts, findPrompt } from '../prompts'

describe('mcp prompt registry', () => {
  it('exposes the five single-action prompts and kvittojakten', () => {
    expect(prompts).toHaveLength(6)
    const names = prompts.map((p) => p.name).sort()
    expect(names).toEqual([
      'cash_today',
      'kvittojakten',
      'last_month_result',
      'uncategorized_count',
      'vat_due',
      'whats_overdue',
    ])
  })

  it('every prompt has description and non-trivial text', () => {
    for (const p of prompts) {
      expect(p.description).toBeTruthy()
      expect(p.text.length).toBeGreaterThan(40)
    }
  })

  it('prompt names are snake_case and unique', () => {
    const seen = new Set<string>()
    for (const p of prompts) {
      expect(p.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(seen.has(p.name)).toBe(false)
      seen.add(p.name)
    }
  })

  it('findPrompt returns the matching prompt', () => {
    expect(findPrompt('vat_due')?.name).toBe('vat_due')
  })

  it('findPrompt returns null for an unknown name', () => {
    expect(findPrompt('does_not_exist')).toBeNull()
  })
})
