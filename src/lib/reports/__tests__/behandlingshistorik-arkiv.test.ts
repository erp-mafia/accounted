import { describe, it, expect } from 'vitest'
import { arkivActivityEvents, companyFactEvents } from '../behandlingshistorik'
import { BEHANDLINGSHISTORIK_CATEGORIES, BEHANDLINGSHISTORIK_CATEGORY_LABELS } from '../behandlingshistorik-types'

describe('Arkiv in the behandlingshistorik', () => {
  it('is a category of its own with a label', () => {
    expect(BEHANDLINGSHISTORIK_CATEGORIES).toContain('arkiv')
    expect(BEHANDLINGSHISTORIK_CATEGORY_LABELS.arkiv).toBe('Arkiv')
  })

  it('makes a recorded fact one event, a superseding fact a replacement, and a deprecation a second event', () => {
    const labels = (p: string) => ({ vat_period: 'Momsperiod' })[p] ?? p
    const base = { predicate: 'vat_period', value_text: 'kvartal', subject_kind: 'company', sys_to: null, rank: 'normal', deprecation_reason: null, supersedes_id: null, source_kind: 'extraction', source_document_id: 'doc-1', approved_by_user_id: null, rationale: null }
    expect(companyFactEvents({ ...base, id: 'f1', sys_from: '2026-09-15T08:00:00Z' }, labels)).toEqual([
      expect.objectContaining({ id: 'fact:f1', category: 'arkiv', code: 'fact.recorded', event: 'Faktum fastställt', object: 'Momsperiod: kvartal', details: ['läst ur dokument'], actor: { type: 'system', user_id: null, actor_label: 'Arkiv' } }),
    ])
    const replaced = companyFactEvents({ ...base, id: 'f2', sys_from: '2026-09-16T08:00:00Z', supersedes_id: 'f1', source_kind: 'agent', approved_by_user_id: 'user-1', rationale: 'Beslutet säger kvartal.' }, labels)
    expect(replaced[0]).toMatchObject({ code: 'fact.superseded', event: 'Faktum ersatt', actor: { type: 'user', user_id: 'user-1' }, details: ['föreslaget av agent, godkänt av person', 'Beslutet säger kvartal.'] })
    const deprecated = companyFactEvents({ ...base, id: 'f2', sys_from: '2026-09-16T08:00:00Z', sys_to: '2026-09-17T08:00:00Z', rank: 'deprecated', deprecation_reason: 'fel sida' }, labels)
    expect(deprecated.map((e) => e.code)).toEqual(['fact.recorded', 'fact.deprecated'])
    expect(deprecated[1]).toMatchObject({ occurred_at: '2026-09-17T08:00:00.000Z', details: ['fel sida'] })
  })

  it('dates a schema version and a software version by their first use for the company', () => {
    const rows = [
      { id: 'a2', kind: 'extract', schema_type: 'agreement.loan', schema_version: 1, model_ids: ['sonnet', 'haiku'], started_at: '2026-09-16T10:00:00Z', agents: { name: 'arkiv.extract', version: '1' } },
      { id: 'a1', kind: 'extract', schema_type: 'agreement.loan', schema_version: 1, model_ids: ['sonnet', 'haiku'], started_at: '2026-09-15T10:00:00Z', agents: { name: 'arkiv.extract', version: '1' } },
      { id: 'a3', kind: 'extract', schema_type: 'agreement.loan', schema_version: 2, model_ids: ['sonnet'], started_at: '2026-10-01T10:00:00Z', agents: { name: 'arkiv.extract', version: '2' } },
    ]
    const events = arkivActivityEvents(rows)
    expect(events.map((e) => [e.code, e.object, e.occurred_at])).toEqual([
      ['arkiv.schema_in_use', 'agreement.loan version 1', '2026-09-15T10:00:00.000Z'],
      ['arkiv.agent_in_use', 'arkiv.extract version 1', '2026-09-15T10:00:00.000Z'],
      ['arkiv.schema_in_use', 'agreement.loan version 2', '2026-10-01T10:00:00.000Z'],
      ['arkiv.agent_in_use', 'arkiv.extract version 2', '2026-10-01T10:00:00.000Z'],
    ])
    expect(events[0].details).toEqual(['Modeller: sonnet, haiku'])
  })
})
