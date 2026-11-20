import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BEGIN,
  END,
  collectShippedPackages,
  renderGenerated,
  replaceGenerated,
  type Lockfile,
} from '../generate-notice'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

describe('collectShippedPackages', () => {
  it('lists every non-dev package once, named from its path or alias', () => {
    const lock: Lockfile = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '0.1.0' },
        'node_modules/zod': { version: '4.0.0', license: 'MIT' },
        'node_modules/vitest': { version: '4.0.0', license: 'MIT', dev: true },
        'node_modules/@img/sharp-libvips-linux-x64': { version: '1.3.3', license: 'LGPL-3.0-or-later' },
        'node_modules/a/node_modules/zod': { version: '4.0.0', license: 'MIT' },
        'node_modules/a/node_modules/zod-old': { name: 'zod', version: '3.0.0', license: 'MIT' },
        'node_modules/local': { link: true },
      },
    }

    const { packages, errors } = collectShippedPackages(lock)

    expect(errors).toEqual([])
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'zod@4.0.0',
      '@img/sharp-libvips-linux-x64@1.3.3',
      'zod@3.0.0',
    ])
  })

  it('takes a missing license from LICENSE_OVERRIDES and reports one with no override', () => {
    const lock: Lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/png-js': { version: '2.0.0' },
        'node_modules/mystery': { version: '1.0.0' },
      },
    }

    const { packages, errors } = collectShippedPackages(lock)

    expect(packages).toEqual([{ name: 'png-js', version: '2.0.0', license: 'MIT', path: 'node_modules/png-js' }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('mystery@1.0.0')
  })
})

describe('renderGenerated', () => {
  it('groups by license, largest group first, packages sorted by name', () => {
    const out = renderGenerated([
      { name: 'b', version: '1.0.0', license: 'MIT', path: '' },
      { name: 'x', version: '1.0.0', license: 'Apache-2.0', path: '' },
      { name: 'a', version: '1.0.0', license: 'MIT', path: '' },
    ])

    expect(out.startsWith(BEGIN)).toBe(true)
    expect(out.endsWith(END)).toBe(true)
    expect(out).toContain('MIT (2)\n  a 1.0.0\n  b 1.0.0\n\nApache-2.0 (1)\n  x 1.0.0')
  })
})

describe('replaceGenerated', () => {
  it('rewrites only the marked block and refuses a file without markers', () => {
    const notice = `header\n${BEGIN}\nold\n${END}\nfooter\n`
    expect(replaceGenerated(notice, `${BEGIN}\nnew\n${END}`)).toBe(`header\n${BEGIN}\nnew\n${END}\nfooter\n`)
    expect(replaceGenerated('no markers', 'x')).toBeNull()
  })
})

describe('committed NOTICE', () => {
  it('matches package-lock.json (run `npm run notice:generate` when this fails)', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lockfile
    const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8')
    const { packages, errors } = collectShippedPackages(lock)

    expect(errors).toEqual([])
    expect(replaceGenerated(notice, renderGenerated(packages))).toBe(notice)
  })
})
