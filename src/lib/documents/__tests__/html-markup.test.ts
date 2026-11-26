import { describe, expect, it } from 'vitest'
import { replaceBlocks, replaceUpToLastCloser } from '../html-markup'

// The expected texts are what each plain global regex gives for the same input.

describe('replaceUpToLastCloser', () => {
  it.each([
    ['a<b>c<d', 'a c<d'],
    ['<<a>>', ' >'],
    ['x < y > z <', 'x   z <'],
    ['', ''],
    ['no tags', 'no tags'],
  ])('replaces tags in %j as /<[^>]*>/g did', (text, expected) => {
    expect(replaceUpToLastCloser(text, /<[^>]*>/g, ' ', '>')).toBe(expected)
  })

  it('replaces non-empty tags, comments, style blocks and line-break tags as their patterns did', () => {
    expect(replaceUpToLastCloser('<>a<b>', /<[^>]+>/g, ' ', '>')).toBe('<>a ')
    expect(replaceUpToLastCloser('a<b', /<[^>]+>/g, ' ', '>')).toBe('a<b')
    expect(replaceUpToLastCloser('a<!-- x -->b<!-- y --!>c<!-- z', /<!--[\s\S]*?--!?>/g, ' ', /--!?>/g)).toBe('a b c<!-- z')
    expect(replaceUpToLastCloser('<!-->x-->', /<!--[\s\S]*?--!?>/g, ' ', /--!?>/g)).toBe(' ')
    expect(replaceUpToLastCloser('<STYLE>a</Style>b<style>c', /<style[\s\S]*?<\/style>/gi, ' ', /<\/style>/gi)).toBe(' b<style>c')
    expect(replaceUpToLastCloser('a<br>b</p >c<br', /<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6]|table|section|article)\s*>/gi, '\n', '>')).toBe('a\nb\nc<br')
    expect(replaceUpToLastCloser('a<br/>b<hr class="x">c<bra>d<br', /<(br|hr)\b[^>]*\/?>/gi, '\n', '>')).toBe('a\nb\nc<bra>d<br')
  })

  // Each used to search the rest of the text again from every opening. The
  // bound is checked after each size, the smaller first, so a slow helper
  // fails on 256 KB instead of taking minutes on 2 MB.
  it.each([
    ['<', /<[^>]*>/g, '>'],
    ['<a', /<[^>]+>/g, '>'],
    ['<br ', /<(br|hr)\b[^>]*\/?>/gi, '>'],
    ['<!--', /<!--[\s\S]*?--!?>/g, /--!?>/g],
    ['<style', /<style[\s\S]*?<\/style>/gi, /<\/style>/gi],
  ] as const)('answers at once for up to 2 MB of %j that is never closed', (unit, pattern, closer) => {
    const started = Date.now()
    for (const kb of [256, 2048]) {
      const text = unit.repeat(Math.floor((kb * 1024) / unit.length))
      expect(replaceUpToLastCloser(text, pattern, ' ', closer)).toBe(text)
      expect(Date.now() - started).toBeLessThan(1000)
    }
  })
})

describe('replaceBlocks', () => {
  it('replaces each block up to the first end tag of its name, whatever the end tag holds', () => {
    expect(replaceBlocks('<p>a</p><script>x</script ><SCRIPT type="m">y</SCRIPT\n>z', ['script'], 'attributes', ' ')).toBe('<p>a</p>  z')
  })

  it('keeps a block that nothing closes, and an element whose name only starts like the tag', () => {
    expect(replaceBlocks('a<script>b', ['script'], 'attributes', ' ')).toBe('a<script>b')
    expect(replaceBlocks('<script>a</script', ['script'], 'attributes', ' ')).toBe('<script>a</script')
    expect(replaceBlocks('<scripts>a</script>', ['script'], 'attributes', ' ')).toBe('<scripts>a</script>')
  })

  it('with several names, replaces the leftmost block first and closes each with spaces only before its >', () => {
    const tags = ['script', 'style', 'head', 'title']
    expect(replaceBlocks('<head><title>T</title><style>s</style></head>body', tags, 'spaces', ' ')).toBe(' body')
    expect(replaceBlocks('<title>a</title x>b</title>c', tags, 'spaces', ' ')).toBe(' c')
    expect(replaceBlocks('<script>a<style>b</style>', tags, 'spaces', ' ')).toBe('<script>a ')
    expect(replaceBlocks('<HEAD>x</head>y<head>z', tags, 'spaces', ' ')).toBe(' y<head>z')
  })

  it.each([
    ['<script>', ['script'], 'attributes'],
    ['<script ', ['script'], 'attributes'],
    ['</script <script', ['script'], 'attributes'],
    ['<head>', ['script', 'style', 'head', 'title'], 'spaces'],
    ['<script <style <head <title ', ['script', 'style', 'head', 'title'], 'spaces'],
  ] as const)('answers at once for up to 2 MB of %j that is never closed', (unit, tags, end) => {
    const started = Date.now()
    for (const kb of [256, 2048]) {
      const text = `${unit.repeat(Math.floor((kb * 1024) / unit.length))}>`
      expect(replaceBlocks(text, tags, end, ' ')).toBe(text)
      expect(Date.now() - started).toBeLessThan(1000)
    }
  })
})
