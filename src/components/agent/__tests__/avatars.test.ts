import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AVATAR_OPTIONS, getAvatarUrl } from '../avatars'

/**
 * These avatars used to be fetched from api.dicebear.com on every render, so
 * every authenticated page view of an accounting product told a third party
 * who was looking at it, and a firewalled or self-hosted install showed no
 * faces at all. The point of these tests is that the registry cannot quietly
 * drift back to a remote URL, and that every entry actually has a file.
 */

const PUBLIC_DIR = join(process.cwd(), 'public')

describe('AVATAR_OPTIONS', () => {
  it('serves every avatar from our own origin', () => {
    for (const option of AVATAR_OPTIONS) {
      expect(option.url.startsWith('/'), `${option.id} must be a local path`).toBe(true)
      expect(option.url).not.toMatch(/^https?:/)
      expect(option.url).not.toContain('dicebear.com')
    }
  })

  it('has a real file behind every entry', () => {
    // A registry entry with no file renders a broken image, which looks like a
    // bug in the agent rather than a missing asset.
    for (const option of AVATAR_OPTIONS) {
      expect(existsSync(join(PUBLIC_DIR, option.url)), `missing file for ${option.id}`).toBe(true)
    }
  })

  it('ships avatars that make no network requests of their own', () => {
    // Self-hosting the file is pointless if the file then phones home. This
    // asserts the PROPERTY (nothing points off-origin) rather than a list of
    // elements: an allowlist of <image> and xlink:href would still let a
    // future asset through via <use href>, <feImage href>, or a
    // scheme-relative //host, which is how this sort of guard rots.
    for (const option of AVATAR_OPTIONS) {
      const svg = readFileSync(join(PUBLIC_DIR, option.url), 'utf8')

      // Namespace declarations and the licence metadata legitimately contain
      // URLs and are never fetched, so they are removed before the check
      // rather than special-cased inside it.
      const referencing = svg
        .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
        .replace(/xmlns(:[a-z0-9-]+)?\s*=\s*"[^"]*"/gi, '')
        .replace(/xsi:type\s*=\s*"[^"]*"/gi, '')

      expect(referencing, `${option.id} references an absolute URL`).not.toMatch(/https?:\/\//i)
      // Scheme-relative: "//host/x" inherits the page's scheme and still
      // leaves the origin.
      expect(referencing, `${option.id} references a scheme-relative URL`).not.toMatch(
        /(href|src)\s*=\s*"\/\//i,
      )
      expect(referencing).not.toMatch(/url\(\s*['"]?\/\//i)
      expect(referencing, `${option.id} contains a script`).not.toMatch(/<script/i)
      expect(referencing, `${option.id} contains a foreignObject`).not.toMatch(/<foreignObject/i)
    }
  })

  it('keeps ids and files one-to-one', () => {
    const ids = AVATAR_OPTIONS.map((a) => a.id)
    const urls = AVATAR_OPTIONS.map((a) => a.url)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(urls).size).toBe(urls.length)
  })
})

describe('getAvatarUrl', () => {
  it('resolves a known id and returns null otherwise', () => {
    expect(getAvatarUrl('notionists-1')).toBe('/agent-avatars/notionists-1.svg')
    // Null is what makes AgentAvatar fall back to its glyph, so an id from an
    // older profile degrades to a placeholder rather than a broken image.
    expect(getAvatarUrl('notionists-99')).toBeNull()
    expect(getAvatarUrl(null)).toBeNull()
    expect(getAvatarUrl(undefined)).toBeNull()
    expect(getAvatarUrl('')).toBeNull()
  })

  it('does not resolve inherited Object keys', () => {
    expect(getAvatarUrl('toString')).toBeNull()
    expect(getAvatarUrl('constructor')).toBeNull()
  })
})
