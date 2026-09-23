import { describe, it, expect } from 'vitest'
import { createElement, isValidElement } from 'react'
import { coerceToastNode } from '../toaster'

/**
 * The Toaster is a sibling of {children} in the ROOT layout, so a throw here
 * escapes both app/error.tsx and app/(dashboard)/error.tsx and lands on
 * global-error, blanking the whole app (and, because global-error reloads
 * once, pinning the user on the fallback for that path).
 *
 * Call sites that forward an unchecked `await res.json()` field pass the
 * canonical `{ code, message, … }` envelope OBJECT instead of a string, which
 * React refuses to render. This coercion is the choke point.
 */
describe('coerceToastNode', () => {
  it('passes strings and numbers through untouched', () => {
    expect(coerceToastNode('Kunde inte spara')).toBe('Kunde inte spara')
    expect(coerceToastNode(42)).toBe(42)
  })

  it('passes null/undefined through so the description simply does not render', () => {
    expect(coerceToastNode(null)).toBeNull()
    expect(coerceToastNode(undefined)).toBeUndefined()
  })

  it('keeps React elements renderable', () => {
    const el = createElement('span', null, 'hej')
    expect(coerceToastNode(el)).toBe(el)
    expect(isValidElement(coerceToastNode(el))).toBe(true)
  })

  it('turns a canonical error envelope into a readable string instead of throwing', () => {
    const result = coerceToastNode({
      code: 'NOT_FOUND',
      message: 'Leverantören hittades inte',
    } as unknown as React.ReactNode)
    expect(typeof result).toBe('string')
    expect(result).toBe('Leverantören hittades inte')
  })

  it('turns any other object into a string rather than a React child throw', () => {
    const result = coerceToastNode({ requestId: 'abc' } as unknown as React.ReactNode)
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('coerces objects nested inside an array child', () => {
    const el = createElement('span', { key: 'a' }, 'hej')
    const result = coerceToastNode([
      'text',
      { code: 'NOT_FOUND', message: 'Hittades inte' },
      el,
    ] as unknown as React.ReactNode) as unknown[]
    expect(result[0]).toBe('text')
    expect(result[1]).toBe('Hittades inte')
    // Elements pass through by identity so their keys survive.
    expect(result[2]).toBe(el)
  })

  it('drops booleans, which React would render as nothing anyway', () => {
    expect(coerceToastNode(true)).toBeNull()
    expect(coerceToastNode(false)).toBeNull()
  })
})
