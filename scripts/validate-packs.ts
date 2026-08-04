#!/usr/bin/env npx tsx
/**
 * CI gate for the konteringspaket catalogue.
 *
 * Schema validation alone is not enough. The failure this whole format exists
 * to prevent (PR #1321: seeded reference data that contradicted what the engine
 * actually books) passes any structural check: the JSON was well-formed, the
 * account numbers were four digits, and the values were still wrong. So the
 * gate also asserts the things that make a pack *correct*:
 *
 *   1. Schema (lib/packs/schema.ts), including the vat_rate / ratio split.
 *   2. Filename equals meta.slug: the slug is the public lookup key.
 *   3. Slugs and meta.order are unique. Order is the single source of truth for
 *      display order in both the gallery and the docs, so a duplicate makes the
 *      two surfaces disagree non-deterministically.
 *   4. Every account exists in the BAS 2026 reference chart. This is the #1321
 *      check.
 *   5. The pack BALANCES when applied, using the real applyTemplate() rather
 *      than a reimplementation, so the validator tests what the product does.
 *   6. Debit and credit are both present: a template posting only one side can
 *      never produce a legal verifikat.
 *
 * Usage:
 *   npx tsx scripts/validate-packs.ts          # validate (CI)
 *   npx tsx scripts/validate-packs.ts --json   # machine-readable summary
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPacks, sortPacks, type LoadedPack } from '../lib/packs/load'
import { applyTemplate } from '../lib/bookkeeping/template-library'
import { getBASReference } from '../lib/bookkeeping/bas-reference'
import type { BookingTemplateLibraryLine } from '../types'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Amounts a pack is test-applied at. Deliberately awkward so rounding shows up. */
const PROBE_AMOUNTS = [100, 1000, 1234.56, 99.99, 3333.33]

/**
 * Pre-existing breakage in the 26 templates ported out of migration
 * 20260413160000, quarantined so the format port stays lossless.
 *
 * These are NOT accepted as correct. They are recorded, visible, and bounded:
 * a quarantined pack's findings are reported as warnings instead of failures,
 * a NEW finding on any pack still fails the build, and fixing one requires
 * deleting its entry here (the validator fails if a quarantined pack turns out
 * to be clean, so the list can only shrink).
 *
 * They are not fixed in this PR on purpose. Each is a Swedish accounting
 * content change to a user-facing template, which is a domain decision that
 * deserves its own review rather than riding along inside a file-format change.
 */
const KNOWN_BROKEN: Record<string, string> = {
  // Empty, and that is the point: the four templates ported out of migration
  // 20260413160000 with real defects (an unbalanced salary template, and
  // accounts that could not resolve) were fixed rather than accepted. The list
  // may only shrink; the validator fails if an entry here validates cleanly, so
  // a stale quarantine cannot linger.
}

interface Failure {
  file: string
  message: string
}

function checkAccountsExist(p: LoadedPack, fail: (m: string) => void): void {
  for (const line of p.pack.lines) {
    if (!getBASReference(line.account)) {
      fail(
        `account ${line.account} ("${line.label}") is not in the BAS 2026 reference chart. ` +
          `A pack may only reference standard accounts.`,
      )
    }
  }
}

function checkBothSidesPresent(p: LoadedPack, fail: (m: string) => void): void {
  const sides = new Set(p.pack.lines.map((l) => l.side))
  if (!sides.has('debit') || !sides.has('credit')) {
    fail(`has only ${[...sides].join('/')} lines: a verifikat needs both a debit and a credit side`)
  }
}

function checkBalances(p: LoadedPack, fail: (m: string) => void): void {
  for (const amount of PROBE_AMOUNTS) {
    const lines = applyTemplate(p.pack.lines as unknown as BookingTemplateLibraryLine[], amount)
    let debit = 0
    let credit = 0
    for (const l of lines) {
      debit += l.debit_amount ? Number(l.debit_amount) : 0
      credit += l.credit_amount ? Number(l.credit_amount) : 0
    }
    // Compare in öre to avoid float noise on the sum itself.
    const debitOre = Math.round(debit * 100)
    const creditOre = Math.round(credit * 100)
    if (debitOre !== creditOre) {
      fail(
        `does not balance at ${amount} kr: debit ${(debitOre / 100).toFixed(2)} vs credit ` +
          `${(creditOre / 100).toFixed(2)} (difference ${((debitOre - creditOre) / 100).toFixed(2)})`,
      )
      return
    }
    if (debitOre === 0) {
      fail(`applies to zero at ${amount} kr: every ratio is 0, so the template posts nothing`)
      return
    }
  }
}

function main(): void {
  const asJson = process.argv.includes('--json')
  const { packs, errors } = loadPacks(ROOT)
  const failures: Failure[] = errors.map((e) => ({ file: e.file, message: e.message }))
  const quarantined: Failure[] = []
  /** Quarantined slugs that produced no finding: their entry is now stale. */
  const cleanButQuarantined = new Set(Object.keys(KNOWN_BROKEN))

  // Cross-file uniqueness.
  const bySlug = new Map<string, string[]>()
  const byOrder = new Map<number, string[]>()

  for (const p of packs) {
    const isQuarantined = p.pack.meta.slug in KNOWN_BROKEN
    // Structural problems always fail, even for a quarantined pack: the
    // quarantine covers accounting content, not a malformed file.
    const fail = (m: string) => failures.push({ file: p.file, message: m })
    // Semantic problems (BAS membership, balance) are downgraded for a
    // quarantined pack and recorded instead.
    const semanticFail = (m: string) => {
      if (isQuarantined) {
        cleanButQuarantined.delete(p.pack.meta.slug)
        quarantined.push({ file: p.file, message: m })
      } else {
        failures.push({ file: p.file, message: m })
      }
    }

    if (p.fileSlug !== p.pack.meta.slug) {
      fail(`filename is "${p.fileSlug}.yaml" but meta.slug is "${p.pack.meta.slug}": they must match`)
    }
    bySlug.set(p.pack.meta.slug, [...(bySlug.get(p.pack.meta.slug) ?? []), p.file])
    byOrder.set(p.pack.meta.order, [...(byOrder.get(p.pack.meta.order) ?? []), p.file])

    checkAccountsExist(p, semanticFail)
    checkBothSidesPresent(p, semanticFail)
    checkBalances(p, semanticFail)
  }

  for (const [slug, files] of bySlug) {
    if (files.length > 1) {
      failures.push({ file: files.join(', '), message: `duplicate meta.slug "${slug}"` })
    }
  }
  for (const [order, files] of byOrder) {
    if (files.length > 1) {
      failures.push({
        file: files.join(', '),
        message:
          `duplicate meta.order ${order}. Order is the single source of truth for display order ` +
          `in both the gallery and the docs; a duplicate makes them disagree.`,
      })
    }
  }

  // A quarantined pack that no longer produces a finding must be released, or
  // the list silently grows stale and stops meaning anything.
  for (const slug of cleanButQuarantined) {
    if (packs.some((p) => p.pack.meta.slug === slug)) {
      failures.push({
        file: `packs/${slug}.yaml`,
        message:
          `is in KNOWN_BROKEN but now validates cleanly. Delete its entry from ` +
          `scripts/validate-packs.ts: the quarantine list may only shrink.`,
      })
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ packs: packs.length, failures, quarantined }, null, 2))
    process.exit(failures.length ? 1 : 0)
  }

  if (quarantined.length) {
    console.warn(`\n! ${quarantined.length} known pre-existing problem(s), quarantined (see KNOWN_BROKEN):`)
    for (const q of quarantined) console.warn(`  ${q.file}\n      ${q.message}`)
  }

  if (failures.length) {
    console.error(`\n✗ Pack validation failed: ${failures.length} problem(s)\n`)
    for (const f of failures) console.error(`  ${f.file}\n      ${f.message}`)
    console.error('\n  → schema and rationale: lib/packs/schema.ts')
    process.exit(1)
  }

  const ordered = sortPacks(packs)
  console.log(
    `\n✓ Packs valid: ${packs.length} pack(s), orders ${ordered[0]?.pack.meta.order}-${
      ordered[ordered.length - 1]?.pack.meta.order
    }, all balance at ${PROBE_AMOUNTS.length} probe amounts (${quarantined.length} quarantined).`,
  )
}

main()
