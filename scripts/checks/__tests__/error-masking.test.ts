/**
 * Proof that the error-masking guard flags errors caught and dropped without
 * a trace, and leaves alone every handler that logs, warns, rethrows, passes
 * the error on, answers a typed failure or says in a comment why ignoring it
 * is safe. Fixtures live in an OS temp directory the test deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findErrorMasking, findErrorMaskingInSource, formatErrorMasking } from '../error-masking.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'error-masking-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

const kinds = (src: string) => findErrorMaskingInSource('x.ts', src).map((f) => f.kind)

describe('error-masking guard', () => {
  it('flags an empty catch, a catch that only returns, and swallowing .catch handlers', () => {
    expect(kinds(`try { a() } catch {}`)).toEqual(['empty catch'])
    expect(kinds(`try { a() } catch (e) {}`)).toEqual(['empty catch'])
    expect(kinds(`function f() { try { return a() } catch { return null } }`)).toEqual(['catch without trace'])
    expect(kinds(`for (const x of xs) { try { a(x) } catch { continue } }`)).toEqual(['catch without trace'])
    expect(kinds(`save().catch(() => {})`)).toEqual(['.catch swallowing'])
    expect(kinds(`save().catch(() => null)`)).toEqual(['.catch swallowing'])
    expect(kinds(`save().catch(() => undefined)`)).toEqual(['.catch swallowing'])
    expect(kinds(`save().catch((_e) => false)`)).toEqual(['.catch swallowing'])
    expect(kinds(`save().catch(function () {})`)).toEqual(['.catch swallowing'])
    expect(kinds(`save().catch(() => { return null })`)).toEqual(['.catch swallowing'])
  })

  it('leaves alone handlers that log, warn, rethrow, pass the error on or answer a typed failure', () => {
    const ok = [
      `try { a() } catch (e) { log.warn('a failed', { error: e }) }`,
      `try { a() } catch (e) { throw new Wrapped(e) }`,
      `function f() { try { a() } catch (e) { return { ok: false, error: e } } }`,
      `function f() { try { a() } catch { return { ok: false, code: 'UNREADABLE' } } }`,
      `function f() { try { a() } catch (e) { return e } }`,
      `try { a() } catch { warnings.push({ code: 'X' }) }`,
      `save().catch((e) => log.error('save failed', e))`,
    ]
    for (const src of ok) expect(kinds(src), src).toEqual([])
  })

  it('accepts a comment saying why the error is safe to ignore', () => {
    expect(kinds(`try { a() } catch {\n  // best effort: the cache rebuilds on the next read\n}`)).toEqual([])
    expect(kinds(`function f() { try { return JSON.parse(s) } catch { /* not JSON: no payload */ return null } }`)).toEqual([])
    expect(kinds(`save().catch(() => {}) // fire and forget: the cron retries`)).toEqual([])
  })

  it('leaves the tolerant response-body read alone', () => {
    expect(kinds(`const body = await res.json().catch(() => null)`)).toEqual([])
    expect(kinds(`const text = await res.text().catch(() => '')`)).toEqual([])
  })

  it('scans src with file and line, skipping tests and generated files', () => {
    const root = fixture({
      'lib/a.ts': `export function f() {\n  try {\n    return g()\n  } catch {\n    return null\n  }\n}\n`,
      'components/B.tsx': `export const B = () => { load().catch(() => {}); return null }\n`,
      'lib/__tests__/a.test.ts': `try { a() } catch {}`,
      'lib/b.test.ts': `try { a() } catch {}`,
      'lib/_generated/x.ts': `try { a() } catch {}`,
    })
    const found = findErrorMasking(root)
    expect(found).toEqual([
      { file: 'components/B.tsx', line: 1, kind: '.catch swallowing' },
      { file: 'lib/a.ts', line: 4, kind: 'catch without trace' },
    ])
    expect(formatErrorMasking(found[1])).toBe(
      'Swallowed error in lib/a.ts:4 (catch without trace). Log it (createLogger), surface it as a warning ' +
        '(OperationWarning), rethrow, or add a comment saying why it is safe to ignore.',
    )
  })
})
