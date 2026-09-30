import { describe, it, expect } from 'vitest'
import { dimensionDisplayName } from '../dimension-label'

const registry = [
  { sie_dim_no: 1, name: 'Kostnadsställe' },
  { sie_dim_no: 6, name: 'Projekt' },
  { sie_dim_no: 20, name: 'Region' },
]

describe('dimensionDisplayName', () => {
  it('labels system and custom dimensions by their registry name', () => {
    expect(dimensionDisplayName(registry, '1')).toBe('Kostnadsställe')
    expect(dimensionDisplayName(registry, '6')).toBe('Projekt')
    expect(dimensionDisplayName(registry, '20')).toBe('Region')
  })

  it('accepts the number as a line map key or as a number', () => {
    expect(dimensionDisplayName(registry, 20)).toBe('Region')
  })

  it("falls back to 'Dim N' while the registry loads or for an unregistered number", () => {
    expect(dimensionDisplayName(null, '1')).toBe('Dim 1')
    expect(dimensionDisplayName(undefined, '6')).toBe('Dim 6')
    expect(dimensionDisplayName([], '20')).toBe('Dim 20')
    expect(dimensionDisplayName(registry, '21')).toBe('Dim 21')
  })
})
