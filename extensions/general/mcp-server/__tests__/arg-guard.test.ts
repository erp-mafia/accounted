import { describe, it, expect } from 'vitest'
import { findUnknownArgKeys, listArgKeys } from '../arg-guard'
import { tools } from '../server'

describe('findUnknownArgKeys', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' }, limit: { type: 'number' } },
  }

  it('flags keys the schema does not declare', () => {
    expect(findUnknownArgKeys(schema, { query: 'moms', limit: 5 })).toEqual(['query'])
  })

  it('returns nothing for a well-formed call', () => {
    expect(findUnknownArgKeys(schema, { text: 'moms' })).toEqual([])
    expect(findUnknownArgKeys(schema, {})).toEqual([])
  })

  it('tolerates company_id everywhere (the routing layer owns it)', () => {
    expect(findUnknownArgKeys(schema, { text: 'x', company_id: 'c-1' })).toEqual([])
  })

  it('is inert for a schema that allows additional properties', () => {
    expect(findUnknownArgKeys({ type: 'object', additionalProperties: true }, { anything: 1 })).toEqual([])
  })

  it('lists the declared keys for the error message', () => {
    expect(listArgKeys(schema)).toEqual(['text', 'limit'])
    expect(listArgKeys({ type: 'object' })).toEqual([])
  })

  it('would have caught the reported gnubok_query_journal misspelling', () => {
    // Feedback seq 261545: {query: "..."} instead of {text: "..."} returned the
    // whole journal (7321 rows) with applied_filters.text null.
    const queryJournal = tools.find((t) => t.name === 'gnubok_query_journal')!
    const unknown = findUnknownArgKeys(
      queryJournal.inputSchema as Record<string, unknown>,
      { query: 'hyra' },
    )
    expect(unknown).toEqual(['query'])
    expect(listArgKeys(queryJournal.inputSchema as Record<string, unknown>)).toContain('text')
  })
})
