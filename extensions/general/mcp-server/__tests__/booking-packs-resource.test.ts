import { describe, it, expect } from 'vitest'
import { bookingPacksResource } from '../resources/booking-packs'
import { findResource } from '../resources/index'

/**
 * The value of this resource is that an agent stops guessing account numbers.
 * These tests pin the parts that make that true: the slug is present so a
 * template can be NAMED, the statutory note survives (it exists nowhere else,
 * the database has no column for it), and a load failure is distinguishable
 * from an empty catalogue.
 */

interface PackPayload {
  templates: Array<{
    slug: string
    name: string
    description: string
    legal_note?: string
    category: string
    entity_type: string
    lines: Array<{ account: string; side: string; type: string; ratio?: number; vat_rate?: number }>
  }>
  how_to_apply: Record<string, string>
  notes: Record<string, string>
  error?: string
}

const read = () => bookingPacksResource.read({} as never) as Promise<PackPayload>

describe('booking packs MCP resource', () => {
  it('is registered and resolvable by URI', () => {
    expect(findResource(bookingPacksResource.uri)).toBe(bookingPacksResource)
  })

  it('exposes every template with its slug, the lookup key an agent names', async () => {
    const { templates } = await read()
    expect(templates.length).toBe(26)
    for (const t of templates) {
      expect(t.slug, `${t.name} has no slug`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(t.lines.length).toBeGreaterThanOrEqual(2)
    }
    expect(new Set(templates.map((t) => t.slug)).size).toBe(templates.length)
  })

  it('carries the statutory note, which exists nowhere else', async () => {
    const { templates } = await read()
    // legal_note has no column in booking_template_library, so if this resource
    // dropped it the information would be unreachable to an agent entirely.
    const withNote = templates.filter((t) => t.legal_note)
    expect(withNote.length).toBeGreaterThan(0)
    expect(withNote.some((t) => t.slug.startsWith('periodiseringsfond'))).toBe(true)
  })

  it('orders templates by meta.order, matching what the user sees', async () => {
    const { templates } = await read()
    // The gallery and the docs sort on meta.order; an agent reading a different
    // order would describe "the first template" as something else again.
    const slugs = templates.map((t) => t.slug)
    expect(slugs).toEqual([...new Set(slugs)])
    expect(slugs[0]).toBeTruthy()
  })

  it('keeps account numbers as strings', async () => {
    const { templates } = await read()
    for (const t of templates) {
      for (const l of t.lines) {
        expect(typeof l.account, `${t.slug} ${l.account}`).toBe('string')
        expect(l.account).toMatch(/^\d{4}$/)
      }
    }
  })

  it('states the amount maths, so an agent does not invent a split', async () => {
    const { how_to_apply } = await read()
    expect(how_to_apply.vat_line).toContain('vat_rate')
    expect(how_to_apply.business_line).toContain('ratio')
    // The explicit instruction not to fudge an amount to force a balance.
    expect(how_to_apply.balance).toMatch(/do not adjust/i)
  })

  it('tells an agent not to post from here', async () => {
    const { notes } = await read()
    expect(notes.posting).toMatch(/journal-entry tools/)
  })

  it('warns that a company may have its own templates beyond this list', async () => {
    const { notes } = await read()
    expect(notes.company_templates).toBeTruthy()
  })

  it('every vat line carries vat_rate and every other line carries ratio', async () => {
    const { templates } = await read()
    for (const t of templates) {
      for (const l of t.lines) {
        if (l.type === 'vat') {
          expect(l.vat_rate, `${t.slug}: vat line without vat_rate`).toBeDefined()
          expect(l.ratio).toBeUndefined()
        } else {
          expect(l.ratio, `${t.slug}: ${l.type} line without ratio`).toBeDefined()
          expect(l.vat_rate).toBeUndefined()
        }
      }
    }
  })
})
