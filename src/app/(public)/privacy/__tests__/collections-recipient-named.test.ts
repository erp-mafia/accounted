import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Pins the named collections recipient on /dpa and /privacy.
 *
 * Once the collections provider's contract is signed, the two legal pages
 * name the company a customer can activate for reminders and collection,
 * next to the provider-neutral disclosure that
 * collections-delivery-disclosures.test.ts pins. This test reads the name
 * from the pages instead of repeating it, so the two pages stay the only
 * files that name the provider: the public name guard
 * (scripts/checks/unsigned-provider-names.mjs) allowlists exactly them, and
 * the last case below checks the app source without needing the guard's
 * secret name list.
 */
const SRC = path.resolve(__dirname, '../../../..')
const DPA_FILE = path.resolve(SRC, 'app/(public)/dpa/page.tsx')
const PRIVACY_FILE = path.resolve(SRC, 'app/(public)/privacy/page.tsx')

/** JSX wraps prose over many lines; compare on single-spaced text. */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ')
}

const DPA = flat(fs.readFileSync(DPA_FILE, 'utf8'))
const PRIVACY = flat(fs.readFileSync(PRIVACY_FILE, 'utf8'))

/** A Swedish aktiebolag named with its organisationsnummer: "Name AB (org.nr NNNNNN-NNNN)". */
const NAMED_RECIPIENT = /([A-ZÅÄÖ][\p{L}-]*(?: [A-ZÅÄÖ][\p{L}-]*)* AB) \(org\.nr (\d{6}-\d{4})\)/gu

function namedRecipients(page: string): Array<{ name: string; orgNumber: string }> {
  const seen = new Map<string, { name: string; orgNumber: string }>()
  for (const match of page.matchAll(NAMED_RECIPIENT)) {
    seen.set(`${match[1]}|${match[2]}`, { name: match[1], orgNumber: match[2] })
  }
  return [...seen.values()]
}

/** Swedish organisationsnummer check digit (Luhn over the first nine digits). */
function hasValidCheckDigit(orgNumber: string): boolean {
  const digits = orgNumber.replace('-', '')
  let sum = 0
  for (let i = 0; i < 9; i++) {
    const product = Number(digits[i]) * (i % 2 === 0 ? 2 : 1)
    sum += Math.floor(product / 10) + (product % 10)
  }
  return (10 - (sum % 10)) % 10 === Number(digits[9])
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every index at which `needle` occurs in `haystack`. */
function indexesOf(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

function section(page: string, from: string, to: string): { start: number; end: number } {
  const start = page.indexOf(from)
  const end = page.indexOf(to, start)
  expect(start, `section "${from}" not found`).toBeGreaterThan(-1)
  expect(end, `section "${to}" not found after "${from}"`).toBeGreaterThan(start)
  return { start, end }
}

const [RECIPIENT] = namedRecipients(DPA)

describe('named collections recipient on /dpa and /privacy', () => {
  it('both pages name the same single company with a valid organisationsnummer', () => {
    expect(namedRecipients(DPA)).toHaveLength(1)
    expect(namedRecipients(PRIVACY)).toEqual([RECIPIENT])
    expect(hasValidCheckDigit(RECIPIENT.orgNumber)).toBe(true)
  })

  it('names it for reminders and collection only, with its role taken from its own privacy policy', () => {
    // Invoice delivery through the provider is not offered: the pages name the
    // company only for påminnelser och inkasso. A delivery channel that goes
    // live later has to update both pages before it is switched on.
    const named = escapeRegExp(`${RECIPIENT.name} (org.nr ${RECIPIENT.orgNumber})`)
    const role = `enligt bolagets integritetspolicy är ${RECIPIENT.name} personuppgiftsansvarig för den behandling bolaget utför i sin inkassoverksamhet.`
    for (const page of [DPA, PRIVACY]) {
      expect(page).toMatch(new RegExp(`${named},? för påminnelser och inkasso;`))
      expect(page).toContain(role)
    }
  })

  it('names it only in the recipient prose, never as a sub-processor', () => {
    const dpaSection = section(DPA, '6. Underbiträden', '7. Säkerhet')
    for (const at of indexesOf(DPA, RECIPIENT.name)) {
      expect(at).toBeGreaterThan(dpaSection.start)
      expect(at).toBeLessThan(dpaSection.end)
    }

    // On /privacy: inside section 10, below the recipient table. A row in
    // lib/legal/subprocessors.ts would make the company our underbiträde, with
    // the 30-day notice in /dpa point 6.
    const privacySection = section(PRIVACY, '10. Mottagare', '11. Överföring')
    const tableEnd = PRIVACY.indexOf('<RecipientTable view="privacy" />', privacySection.start)
    expect(tableEnd).toBeGreaterThan(privacySection.start)
    const occurrences = indexesOf(PRIVACY, RECIPIENT.name)
    expect(occurrences.length).toBeGreaterThan(0)
    for (const at of occurrences) {
      expect(at).toBeGreaterThan(tableEnd)
      expect(at).toBeLessThan(privacySection.end)
    }
  })

  it('no other app source file names it', () => {
    // The company name without " AB", lower-cased: catches inflected,
    // compound and camelCase forms and host names, like the name guard.
    const stem = RECIPIENT.name.replace(/ AB$/, '').toLowerCase()
    expect(stem.length).toBeGreaterThanOrEqual(4)

    const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|json|md|mdx|css|sql|txt|ya?ml|html)$/
    const naming: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (TEXT_FILE.test(entry.name) && fs.readFileSync(full, 'utf8').toLowerCase().includes(stem)) {
          naming.push(path.relative(SRC, full))
        }
      }
    }
    walk(SRC)

    expect(naming.sort()).toEqual([
      path.relative(SRC, DPA_FILE),
      path.relative(SRC, PRIVACY_FILE),
    ].sort())
    // Reads every source file: about 5 s on a busy CI shard, so it gets its own
    // budget instead of the 5 s default (timed out at 5.3 s on 2026-10-26).
  }, 30_000)
})
