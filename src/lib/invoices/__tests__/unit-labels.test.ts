import { describe, expect, it } from 'vitest'
import { unitLabel } from '@/lib/invoices/unit-labels'

describe('unitLabel', () => {
  it('maps the editor units to English on an English document', () => {
    expect(unitLabel('st', 'en')).toBe('pcs')
    expect(unitLabel('tim', 'en')).toBe('h')
    expect(unitLabel('dag', 'en')).toBe('day')
    expect(unitLabel('månad', 'en')).toBe('month')
  })

  it('leaves units that are the same in both languages alone', () => {
    expect(unitLabel('km', 'en')).toBe('km')
    expect(unitLabel('kg', 'en')).toBe('kg')
  })

  it('prints a Swedish document exactly as stored', () => {
    expect(unitLabel('st', 'sv')).toBe('st')
    expect(unitLabel('tim', 'sv')).toBe('tim')
  })

  it('passes user-typed units through untouched', () => {
    expect(unitLabel('paket', 'en')).toBe('paket')
    expect(unitLabel('m2', 'en')).toBe('m2')
  })

  it('matches case- and whitespace-insensitively', () => {
    expect(unitLabel(' St ', 'en')).toBe('pcs')
    expect(unitLabel('TIM', 'en')).toBe('h')
  })

  it('tolerates a missing unit', () => {
    expect(unitLabel(null, 'en')).toBe('')
    expect(unitLabel(undefined, 'sv')).toBe('')
  })
})
