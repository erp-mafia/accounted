import { describe, expect, it } from 'vitest'
import { claudeDesktopLink } from '../run'

describe('claudeDesktopLink', () => {
  it('opens a Claude Desktop chat or a Cowork task with the prompt filled in', () => {
    expect(claudeDesktopLink('desktop', 'Hitta kvittona som saknas.', true)).toBe('claude://claude.ai/new?q=Hitta%20kvittona%20som%20saknas.')
    expect(claudeDesktopLink('cowork', 'Kör "bookkeep"', true)).toBe('claude://cowork/new?q=K%C3%B6r%20%22bookkeep%22')
  })

  it('opens an empty one when the prompt is copied instead (own items)', () => {
    expect(claudeDesktopLink('desktop', 'Kör mitt arbetsflöde X', false)).toBe('claude://claude.ai/new')
    expect(claudeDesktopLink('cowork', 'Kör mitt arbetsflöde X', false)).toBe('claude://cowork/new')
  })
})
