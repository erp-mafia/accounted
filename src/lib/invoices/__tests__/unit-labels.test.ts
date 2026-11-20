import { describe, expect, it } from 'vitest'
import { unitLabel } from '@/lib/invoices/unit-labels'

describe('unitLabel', () => {
  it('maps the editor units to English on an English document', () => {
    expect(unitLabel('st', 'en')).toBe('pcs')
    expect(unitLabel('tim', 'en')).toBe('h')
    expect(unitLabel('dag', 'en')).toBe('day')
    expect(unitLabel('månad', 'en')).toBe('month')
    expect(unitLabel('vecka', 'en')).toBe('week')
    expect(unitLabel('år', 'en')).toBe('year')
    expect(unitLabel('kvm', 'en')).toBe('m2')
  })

  it('leaves units that are the same in both languages alone', () => {
    expect(unitLabel('km', 'en')).toBe('km')
    expect(unitLabel('kg', 'en')).toBe('kg')
    expect(unitLabel('m', 'en')).toBe('m')
    expect(unitLabel('m3', 'en')).toBe('m3')
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
    expect(unitLabel(null, 'sv', 2)).toBe('')
  })
})

// crm#1480: the PDF printed "2 dag" and "2 day": the unit never saw the quantity.
describe('unitLabel with a quantity', () => {
  it('puts a written-out Swedish unit in the plural unless the quantity is one', () => {
    expect(unitLabel('dag', 'sv', 2)).toBe('dagar')
    expect(unitLabel('dag', 'sv', 1)).toBe('dag')
    expect(unitLabel('månad', 'sv', 3)).toBe('månader')
    expect(unitLabel('vecka', 'sv', 0.5)).toBe('veckor')
    expect(unitLabel('dag', 'sv', 0)).toBe('dagar')
    // A credit note row takes back one day.
    expect(unitLabel('dag', 'sv', -1)).toBe('dag')
    expect(unitLabel('dag', 'sv', -2)).toBe('dagar')
  })

  it('does the same in English', () => {
    expect(unitLabel('dag', 'en', 2)).toBe('days')
    expect(unitLabel('dag', 'en', 1)).toBe('day')
    expect(unitLabel('månad', 'en', 12)).toBe('months')
    expect(unitLabel('mån', 'en', 2)).toBe('months')
    expect(unitLabel('vecka', 'en', 1.5)).toBe('weeks')
    expect(unitLabel('år', 'en', 2)).toBe('years')
  })

  it('inflects a stored word in its own language, either way round', () => {
    expect(unitLabel('hour', 'sv', 8)).toBe('hours')
    expect(unitLabel('piece', 'en', 3)).toBe('pieces')
    expect(unitLabel('timmar', 'sv', 1)).toBe('timme')
    expect(unitLabel('days', 'en', 1)).toBe('day')
  })

  it('keeps abbreviations and words without a plural form unchanged', () => {
    for (const unit of ['tim', 'km', 'st', 'mån', 'kg', 'kvm', 'år', 'meter', 'paket']) {
      expect(unitLabel(unit, 'sv', 2)).toBe(unit)
    }
    expect(unitLabel('st', 'en', 2)).toBe('pcs')
    expect(unitLabel('tim', 'en', 2)).toBe('h')
  })

  it('keeps a leading capital', () => {
    expect(unitLabel('Dag', 'sv', 2)).toBe('Dagar')
    expect(unitLabel(' Dag ', 'sv', 1)).toBe('Dag')
  })
})
