import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Guard against the failure mode that shipped the ROT/RUT payout dialog to
 * production rendering raw key paths: the strings existed in messages/*.json,
 * but under a different namespace than the component read from. next-intl has
 * no build-time check for that, it silently renders "namespace.key", so every
 * label in the feature turned into debug output for real users.
 *
 * This resolves every literal translation key against both locales, so a
 * misplaced namespace fails the suite instead of the UI.
 */

const ROOT = path.resolve(__dirname, '../..')
const SCAN_DIRS = ['app', 'components', 'extensions']
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude'])

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Comments hold example code (`t('none_title')` in a JSDoc usage block) that
 * never runs. Blank them out rather than reporting keys nobody renders.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function resolveKey(messages: unknown, dottedPath: string): unknown {
  return dottedPath
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      messages,
    )
}

interface Reference {
  file: string
  namespace: string
  key: string
}

function collectReferences(): Reference[] {
  const refs: Reference[] = []
  for (const dir of SCAN_DIRS) {
    for (const file of collectSourceFiles(path.join(ROOT, dir))) {
      const src = stripComments(fs.readFileSync(file, 'utf8'))

      // `const t = useTranslations('invoices')` / `= await getTranslations('x')`
      const namespaces: Record<string, string> = {}
      const declaration =
        /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*['"]([^'"]+)['"]\s*\)/g
      for (const match of src.matchAll(declaration)) namespaces[match[1]] = match[2]

      for (const [variable, namespace] of Object.entries(namespaces)) {
        // Literal calls only: t(dynamicKey) cannot be checked statically.
        const call = new RegExp(
          `\\b${variable}(?:\\.rich|\\.markup|\\.raw)?\\(\\s*['"]([A-Za-z0-9_.]+)['"]`,
          'g',
        )
        for (const match of src.matchAll(call)) {
          refs.push({ file: path.relative(ROOT, file), namespace, key: match[1] })
        }
      }
    }
  }
  return refs
}

describe('message keys', () => {
  const references = collectReferences()

  it('finds translation calls to check', () => {
    expect(references.length).toBeGreaterThan(500)
  })

  for (const locale of ['sv', 'en'] as const) {
    it(`resolves every referenced key in messages/${locale}.json`, () => {
      const messages = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8'),
      )

      const missing = references
        .filter(({ namespace, key }) => resolveKey(messages, `${namespace}.${key}`) === undefined)
        .map(({ file, namespace, key }) => `${file}: ${namespace}.${key}`)

      expect([...new Set(missing)]).toEqual([])
    })
  }
})
