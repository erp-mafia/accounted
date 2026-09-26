import { describe, expect, it } from 'vitest'
import { describeRetrievedSkills } from '../retrieved-skills'

describe('describeRetrievedSkills', () => {
  it('names flows, packs, analyses and own items the way the Instruktioner page does', () => {
    expect(describeRetrievedSkills([
      'bookkeep',
      'kvittojakten-claude',
      'horizontal/swedish-vat',
      'analys-kassaprognos',
      'own/00000000-0000-4000-8000-000000000001',
    ])).toEqual([
      { kind: 'workflow', id: 'bookkeep' },
      { kind: 'workflow', id: 'kvittojakten' },
      { kind: 'knowledge', id: 'horizontal/swedish-vat' },
      { kind: 'analysis', slug: 'analys-kassaprognos' },
      { kind: 'own' },
    ])
  })

  it('reads a reference as its pack and lists each thing once', () => {
    expect(describeRetrievedSkills([
      'horizontal/swedish-vat',
      'horizontal/swedish-vat/vat-compliance-reference',
      'kvittojakten-chatgpt',
      'kvittojakten-claude',
      'own/00000000-0000-4000-8000-000000000001',
      'own/00000000-0000-4000-8000-000000000002',
    ])).toEqual([
      { kind: 'knowledge', id: 'horizontal/swedish-vat' },
      { kind: 'workflow', id: 'kvittojakten' },
      { kind: 'own' },
    ])
  })

  it('keeps the slug of anything the page does not list, without a uuid or community prefix', () => {
    expect(describeRetrievedSkills(['bank-reconciliation', 'community/stang-dagskassan'])).toEqual([
      { kind: 'other', slug: 'bank-reconciliation' },
      { kind: 'other', slug: 'stang-dagskassan' },
    ])
  })

  it('returns nothing for no retrievals', () => {
    expect(describeRetrievedSkills([])).toEqual([])
  })
})
