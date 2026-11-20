import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import nextConfig from '../../../../../next.config'

// /.well-known/skills (the directory) has no route of its own. On Vercel the
// request fell through to a pages-router lookup and answered 500 ("Cannot find
// module './.next/server/pages/.well-known/skills.js'", 145+ times since
// 2026-09-16). It now redirects to the catalogue at index.json.
describe('/.well-known/skills', () => {
  it('redirects both spellings of the directory to the catalogue, temporarily', async () => {
    const rules = (await nextConfig.redirects!()).filter((rule) =>
      rule.source.startsWith('/.well-known/skills'),
    )
    expect(rules.map((rule) => rule.source).sort()).toEqual([
      '/.well-known/skills',
      '/.well-known/skills/',
    ])
    for (const rule of rules) {
      expect(rule).toMatchObject({ destination: '/.well-known/skills/index.json', permanent: false })
      // No host condition: the legacy host keeps answering /.well-known too.
      expect('has' in rule && rule.has).toBeFalsy()
    }
  })

  it('points at a route that exists', () => {
    expect(existsSync(path.join(__dirname, '..', 'index.json', 'route.ts'))).toBe(true)
  })
})
