import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RECIPIENTS } from '@/lib/legal/subprocessors'

/**
 * Pins the provider-neutral disclosure of invoice delivery and collection
 * through an inkasso- och utskicksföretag that the customer activates itself.
 *
 * The wording describes a recipient category, the data that reaches it and
 * when, and the role split: the customer contracts with the provider
 * directly, so it is not one of our underbiträden and never a row in the
 * recipient list (lib/legal/subprocessors.ts). Like
 * ai-and-replay-disclosures.test.ts this asserts on the page source, because
 * the pages are server components and the repo has no component harness.
 */
const ROOT = path.resolve(__dirname, '../../../..')
const REPO_ROOT = path.resolve(ROOT, '..')

/** JSX wraps prose over many lines; compare on single-spaced text. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ')
}

const PRIVACY = flat(fs.readFileSync(path.resolve(ROOT, 'app/(public)/privacy/page.tsx'), 'utf8'))
const DPA = flat(fs.readFileSync(path.resolve(ROOT, 'app/(public)/dpa/page.tsx'), 'utf8'))

describe('invoice delivery and collection recipients (provider-neutral)', () => {
  it('the DPA lists the purpose and the personnummer category for private customers', () => {
    expect(DPA).toContain(
      'lämna fakturor till påminnelse och inkasso, och skicka fakturor, via ett inkasso- och utskicksföretag som Kunden själv aktiverar',
    )
    expect(DPA).toContain('för privatpersoner även personnummer')
  })

  it('both pages describe the provider as a recipient the customer engages, not our underbiträde', () => {
    expect(DPA).toContain('Inkasso- och utskicksföretag som Kunden aktiverar.')
    expect(DPA).toContain('Företaget anlitas inte av Biträdet och är inte Biträdets underbiträde')
    expect(PRIVACY).toContain('Inkasso- och utskicksföretag som du aktiverar.')
    expect(PRIVACY).toContain('Företaget är en mottagare som du själv anlitar, inte vårt underbiträde')
  })

  it('never adds the activated provider to the recipient list', () => {
    // A row there would make it our underbiträde (or our own processor), with
    // the 30-day notice in /dpa point 6. The provider is disclosed in prose.
    const list = JSON.stringify(RECIPIENTS).toLowerCase()
    expect(list).not.toContain('inkasso')
    expect(list).not.toContain('utskick')
  })

  it('ties every transfer to an instruction and nothing to the time before the application', () => {
    // Data leaves at "Skicka ansökan", before the provider approves; "Aktiverat"
    // in the app means approved, so the pages name the user's own steps instead.
    expect(DPA).toContain('utgör dokumenterade instruktioner enligt punkt 2')
    expect(DPA).toContain(
      'Inga uppgifter lämnas till företaget innan Kunden har godkänt företagets villkor och skickat in ansökan om aktivering.',
    )
    expect(PRIVACY).toContain(
      'Inget skickas innan en ägare eller administratör har godkänt företagets villkor och skickat in ansökan, och sedan bara följande:',
    )
  })

  it('lists every customer field and case input the transfers carry, on both pages', () => {
    // The lists are exhaustive ("bara följande"), so they must cover the whole
    // debtor block a handover or delivery sends (contact details included), the
    // payments and credits sent with a handover, case actions with their
    // message, and reverts sent after a case has closed.
    for (const page of [DPA, PRIVACY]) {
      expect(page).toContain(
        'namn, postadress, e-post och telefonnummer när de finns, samt organisationsnummer eller, för privatpersoner, personnummer',
      )
      expect(page).toContain('fakturan med de betalningar och krediteringar som redan finns på den')
      expect(page).toContain('till exempel paus, återkallelse eller bestridande, med eventuellt meddelande från')
      expect(page).toContain(
        'Om en rapporterad betalning senare tas bort eller ändras meddelas det också, även efter att ärendet har avslutats.',
      )
      expect(page).toContain('namnet på den som godkänner villkoren')
      expect(page).toContain('firmatecknarens e-post om signeringslänken ska skickas dit')
    }
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
