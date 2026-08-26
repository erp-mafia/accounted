/**
 * Proof that the client-node-builtin guard follows static imports from a
 * 'use client' module to a Node builtin, and only those. Fixtures live in an
 * OS temp directory the test creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findClientNodeBuiltins } from '../client-node-builtin.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-builtin-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

describe('client-node-builtin guard', () => {
  it('flags a client component whose lib import chain reaches crypto, with the chain', () => {
    const root = fixture({
      'lib/auth/hashing.ts': `import crypto from 'crypto'\nexport const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')\nexport const isEnabled = () => true\n`,
      'components/Login.tsx': `'use client'\nimport { isEnabled } from '@/lib/auth/hashing'\nexport default function Login() { return isEnabled() ? null : null }\n`,
    })
    const findings = findClientNodeBuiltins(root)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ file: 'components/Login.tsx', builtin: 'crypto' })
    expect(findings[0].chain).toEqual(['components/Login.tsx', 'lib/auth/hashing.ts', 'bare:crypto'])
  })

  it('ignores server modules, type-only imports and dynamic imports', () => {
    const root = fixture({
      'lib/auth/hashing.ts': `import crypto from 'crypto'\nexport type Digest = string\nexport const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')\n`,
      'lib/server-only.ts': `import { hash } from './auth/hashing'\nexport const h = hash\n`,
      'components/TypeOnly.tsx': `'use client'\nimport type { Digest } from '@/lib/auth/hashing'\nexport const d: Digest = ''\n`,
      'components/Lazy.tsx': `'use client'\nexport async function load() { const m = await import('@/lib/auth/hashing'); return m.hash('x') }\n`,
    })
    expect(findClientNodeBuiltins(root)).toEqual([])
  })

  it('resolves the pure sibling pattern as clean', () => {
    const root = fixture({
      'lib/auth/flags.ts': `export const isEnabled = () => true\n`,
      'lib/auth/hashing.ts': `import crypto from 'crypto'\nexport { isEnabled } from './flags'\nexport const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')\n`,
      'components/Login.tsx': `'use client'\nimport { isEnabled } from '@/lib/auth/flags'\nexport default function Login() { return isEnabled() ? null : null }\n`,
    })
    expect(findClientNodeBuiltins(root)).toEqual([])
  })
})
