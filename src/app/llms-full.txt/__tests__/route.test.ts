/**
 * /llms-full.txt carries each cookbook recipe once. Two slugs in the cookbook
 * registry are aliases of another recipe's text; looping over the registry
 * put the quickstart and the webhooks recipe in the export twice.
 */
import { describe, expect, it } from 'vitest'
import { COOKBOOK } from '@/lib/docs/content/cookbook'
import { GET } from '../route'

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('GET /llms-full.txt', () => {
  it('includes every cookbook recipe exactly once', async () => {
    const body = await (await GET()).text()
    const recipes = new Set(COOKBOOK.map((c) => c.markdown).filter((md): md is string => md !== null))
    expect(recipes.size).toBeGreaterThan(0)
    for (const markdown of recipes) {
      const title = markdown.trim().split('\n')[0]
      expect(title.startsWith('# '), title).toBe(true)
      expect(occurrences(body, `${title}\n`), title).toBe(1)
    }
  })
})
