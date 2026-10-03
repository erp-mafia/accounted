import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Pins the provider-neutral disclosure of invoice delivery and collection
 * through an inkasso- och utskicksföretag that the customer activates itself.
 *
 * The wording has to hold before any provider is named on these pages: it
 * describes a recipient category, the data that reaches it and when, and the
 * role split (the customer contracts with the provider directly, so it is not
 * one of our underbiträden and never a row in the sub-processor table). Like
 * ai-and-replay-disclosures.test.ts this asserts on the page source, because
 * the pages are server components and the repo has no component harness.
 */
const ROOT = path.resolve(__dirname, '../../../..')
const REPO_ROOT = path.resolve(ROOT, '..')

/** JSX wraps prose over many lines; compare on single-spaced text. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ')
}

const PRIVACY_SRC = fs.readFileSync(path.resolve(ROOT, 'app/(public)/privacy/page.tsx'), 'utf8')
const PRIVACY = flat(PRIVACY_SRC)
const DPA = flat(fs.readFileSync(path.resolve(ROOT, 'app/(public)/dpa/page.tsx'), 'utf8'))

/** The sub-processor table on /privacy (section 4). */
function subProcessorTable(): string {
  const start = PRIVACY_SRC.indexOf('<table')
  expect(start, 'no sub-processor table on /privacy').toBeGreaterThan(-1)
  return PRIVACY_SRC.slice(start, PRIVACY_SRC.indexOf('</table>', start))
}

describe('invoice delivery and collection recipients (provider-neutral)', () => {
  it('the DPA lists the purpose and the personnummer category for private customers', () => {
    expect(DPA).toContain(
      'Utskick av fakturor samt påminnelser och inkasso via ett inkasso- och utskicksföretag som den Ansvarige själv aktiverar',
    )
    expect(DPA).toContain('för kunder som är privatpersoner även personnummer')
  })

  it('both pages describe the provider as a recipient the customer engages, not our underbiträde', () => {
    expect(DPA).toContain('Inkasso- och utskicksföretag som den Ansvarige aktiverar.')
    expect(DPA).toContain('Företaget anlitas inte av Biträdet och är inte Biträdets underbiträde')
    expect(PRIVACY).toContain('Inkasso- och utskicksföretag som du aktiverar.')
    expect(PRIVACY).toContain('Företaget är en mottagare som du själv anlitar, inte vårt underbiträde')
  })

  it('never adds the activated provider to the sub-processor table', () => {
    // A row there would make it our underbiträde, with the 30-day notice in
    // /dpa section 6. The provider is disclosed in prose below the table.
    const table = subProcessorTable().toLowerCase()
    expect(table).not.toContain('inkasso')
    expect(table).not.toContain('utskick')
  })

  it('ties every transfer to an instruction and nothing to the time before activation', () => {
    expect(DPA).toContain('utgör dokumenterade instruktioner enligt punkt 2')
    expect(DPA).toContain('Inga uppgifter lämnas till företaget innan den Ansvarige har aktiverat kopplingen.')
    expect(PRIVACY).toContain(
      'Inget skickas innan en ägare eller administratör har aktiverat kopplingen, och sedan bara följande:',
    )
  })

  it('claims customer personnummer is stored encrypted only while the ciphertext CHECK stands', () => {
    expect(PRIVACY).toContain('Kundens personnummer sparas inte i dem; det finns krypterat på kunden.')
    const check = fs.readFileSync(
      path.resolve(
        REPO_ROOT,
        'supabase/migrations/20260726110000_customers_personal_number_ciphertext_check.sql',
      ),
      'utf8',
    )
    expect(check).toContain("CHECK (personal_number IS NULL OR personal_number ~ '^[0-9a-f]{76,255}$')")
    // Nothing after the validating migration touches the constraint again; a
    // later change has to revisit the sentence on /privacy too.
    const migrationsDir = path.resolve(REPO_ROOT, 'supabase/migrations')
    const laterTouches = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql') && file.slice(0, 14) > '20260726110001')
      .filter((file) =>
        fs.readFileSync(path.resolve(migrationsDir, file), 'utf8').includes('customers_personal_number_check'),
      )
    expect(laterTouches).toEqual([])
  })
})
