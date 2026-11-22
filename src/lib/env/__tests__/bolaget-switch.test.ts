import { describe, expect, it } from 'vitest'
import { bolagetRegistersConfigured, bolagetRegistersRollout, bolagetRollout, isBolagetEnabled, isBolagetRegistersEnabled } from '../bolaget-switch'

const A = 'AAAAAAAA-0000-4000-8000-000000000001'
const B = 'BBBBBBBB-0000-4000-8000-000000000002'

describe('Bolaget switches', () => {
  it('are off for everybody while unset or blank', () => {
    expect(bolagetRollout({})).toEqual([])
    expect(bolagetRegistersRollout({ BOLAGET_REGISTERS_COMPANY_IDS: '  ' })).toEqual([])
    expect(isBolagetEnabled(A, {})).toBe(false)
    expect(isBolagetRegistersEnabled(A, {})).toBe(false)
    expect(bolagetRegistersConfigured({})).toBe(false)
  })

  it('opens the registers alone for the companies BOLAGET_REGISTERS_COMPANY_IDS names, whatever the case', () => {
    const env = { BOLAGET_REGISTERS_COMPANY_IDS: `${A.toLowerCase()}, other` }
    expect(isBolagetRegistersEnabled(A, env)).toBe(true)
    expect(isBolagetRegistersEnabled(B, env)).toBe(false)
    expect(isBolagetRegistersEnabled(null, env)).toBe(false)
    // The meetings, the capital events and the owner tax stay on the whole rollout.
    expect(isBolagetEnabled(A, env)).toBe(false)
    expect(bolagetRegistersConfigured(env)).toBe(true)
  })

  it('opens the registers for everyone with *, and nothing else', () => {
    const env = { BOLAGET_REGISTERS_COMPANY_IDS: '*' }
    expect(bolagetRegistersRollout(env)).toBe('all')
    expect(isBolagetRegistersEnabled(B, env)).toBe(true)
    expect(isBolagetEnabled(B, env)).toBe(false)
  })

  it('gives a company in the whole rollout the registers too', () => {
    const env = { BOLAGET_COMPANY_IDS: A, BOLAGET_REGISTERS_COMPANY_IDS: B }
    expect(isBolagetRegistersEnabled(A, env)).toBe(true)
    expect(isBolagetEnabled(A, env)).toBe(true)
    expect(isBolagetRegistersEnabled(B, env)).toBe(true)
    expect(isBolagetEnabled(B, env)).toBe(false)
    expect(bolagetRegistersConfigured({ BOLAGET_COMPANY_IDS: A })).toBe(true)
  })
})
