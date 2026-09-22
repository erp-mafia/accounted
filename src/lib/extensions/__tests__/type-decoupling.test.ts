import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('type decoupling', () => {
  it('types/index.ts must not import from @/extensions/', () => {
    const typesPath = resolve(__dirname, '../../../types/index.ts')
    const content = readFileSync(typesPath, 'utf-8')

    const extensionImports = content
      .split('\n')
      .filter((line) => /from\s+['"]@\/extensions\//.test(line))

    expect(extensionImports).toEqual([])
  })
})
