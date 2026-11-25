import { describe, expect, it } from 'vitest'
import { iconLinks, largestDeclaredSize } from '../html'
import { ALLOW_ALL, parseRobots, patternMatches, robotsAllows } from '../robots'

describe('iconLinks', () => {
  const page = `<!doctype html><html><head>
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32">
    <link rel="mask-icon" href="/pinned.svg" color="#000">
    <link rel='apple-touch-icon' sizes='180x180' href='/apple-180.png'>
    <link href="https://cdn.example.com/icon.svg" rel="icon" type="image/svg+xml">
    <link rel="shortcut icon" href="//cdn.example.com/big.png?v=1&amp;x=2" sizes="192x192">
    <link rel="stylesheet" href="/site.css">
  </head><body><link rel="icon" href="/body-icon.png"></body></html>`

  it('reads apple-touch-icons, SVG icons and other icons from the head, resolved against the page', () => {
    expect(iconLinks(page, 'https://www.example.com/sv/')).toEqual([
      { kind: 'icon', url: 'https://www.example.com/favicon.ico', declaredSize: 32 },
      { kind: 'apple-touch-icon', url: 'https://www.example.com/apple-180.png', declaredSize: 180 },
      { kind: 'svg-icon', url: 'https://cdn.example.com/icon.svg', declaredSize: null },
      { kind: 'icon', url: 'https://cdn.example.com/big.png?v=1&x=2', declaredSize: 192 },
    ])
  })

  it('honours <base href>', () => {
    const html = '<head><base href="https://static.example.com/assets/"><link rel="apple-touch-icon" href="touch.png"></head>'
    expect(iconLinks(html, 'https://example.com/')[0]?.url).toBe('https://static.example.com/assets/touch.png')
  })

  it('drops hrefs that are not web or data URLs', () => {
    const html = '<head><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="file:///etc/passwd"></head>'
    expect(iconLinks(html, 'https://example.com/')).toEqual([])
  })

  it('reads the largest declared size', () => {
    expect(largestDeclaredSize('16x16 180x180 32x32')).toBe(180)
    expect(largestDeclaredSize('any')).toBeNull()
    expect(largestDeclaredSize(undefined)).toBeNull()
  })
})

describe('robots.txt', () => {
  it('uses our own group when there is one, else *', () => {
    const own = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: AccountedLogoFetcher\nAllow: /\n')
    expect(robotsAllows(own, '/apple-touch-icon.png')).toBe(true)
    const star = parseRobots('User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n')
    expect(robotsAllows(star, '/')).toBe(false)
  })

  it('lets the longest rule win, Allow on a tie, with * and $', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/icons\nDisallow: /*.json$\nDisallow:\n')
    expect(robotsAllows(rules, '/private/x')).toBe(false)
    expect(robotsAllows(rules, '/private/icons/a.png')).toBe(true)
    expect(robotsAllows(rules, '/data.json')).toBe(false)
    expect(robotsAllows(rules, '/data.json?x')).toBe(true)
    expect(robotsAllows(rules, '/')).toBe(true)
  })

  it('shares a group between consecutive user-agent lines', () => {
    const rules = parseRobots('User-agent: foo\nUser-agent: accountedlogofetcher\nDisallow: /favicon\n')
    expect(robotsAllows(rules, '/favicon.ico')).toBe(false)
    expect(robotsAllows(rules, '/')).toBe(true)
  })

  it('allows everything without rules', () => {
    expect(robotsAllows(ALLOW_ALL, '/anything')).toBe(true)
  })

  it('matches wildcards without exponential backtracking', () => {
    const hostile = `/${'*a'.repeat(40)}b`
    const started = Date.now()
    expect(patternMatches(hostile, `/${'a'.repeat(200)}`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
    expect(patternMatches('/a*b$', '/axxb')).toBe(true)
    expect(patternMatches('/a*b$', '/axxbc')).toBe(false)
  })

  it('reads a comment and a version to the end of the line, past a U+2028 (RFC 9309 ends lines at CR and LF only)', () => {
    const commented = parseRobots('User-agent: *\nDisallow: /private # note\u2028more\n')
    expect(robotsAllows(commented, '/private/x')).toBe(false)
    expect(robotsAllows(commented, '/')).toBe(true)
    const own = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: AccountedLogoFetcher/1.0\u2028x\nAllow: /\n')
    expect(robotsAllows(own, '/apple-touch-icon.png')).toBe(true)
  })

  it('reads long runs of # and / at once', () => {
    // The answer is the same as before; a slow parse fails on the shorter runs first.
    const started = Date.now()
    for (const n of [60_000, 200_000]) {
      const rules = parseRobots(`User-agent: somebot/${'/'.repeat(n)}\u2028x\nDisallow: /\n\nUser-agent: *\nDisallow: /a${'#'.repeat(n)}\u2028x\n`)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(robotsAllows(rules, '/b')).toBe(true)
    }
  })
})
