import { describe, it, expect } from 'vitest'
import {
  INVALID_STORE_URL_CODE,
  STORE_FIREWALL_CODE,
  UNSAFE_STORE_URL_CODE,
  WooCommerceApiError,
} from '../lib/api-client'
import {
  classifyProbeFailure,
  probeFailureLogFields,
  probeFailureMessage,
  type WooProbeFailureKind,
} from '../lib/probe-failure'

describe('classifyProbeFailure', () => {
  it('names the firewall when something in front of WooCommerce refused (crm#1669)', () => {
    const error = new WooCommerceApiError('WooCommerce API 403', 403, STORE_FIREWALL_CODE, {
      bodyKind: 'html',
    })
    expect(classifyProbeFailure(error)).toBe('firewall')
  })

  it('separates a refused key, a missing API, a redirect, a bad address and a dead host', () => {
    expect(classifyProbeFailure(new WooCommerceApiError('x', 401, 'woocommerce_rest_authentication_error'))).toBe('credentials')
    expect(classifyProbeFailure(new WooCommerceApiError('x', 403, 'woocommerce_rest_cannot_view'))).toBe('credentials')
    expect(classifyProbeFailure(new WooCommerceApiError('x', 404, 'rest_no_route'))).toBe('not_found')
    expect(
      classifyProbeFailure(new WooCommerceApiError('x', 0, UNSAFE_STORE_URL_CODE, { guardReason: 'redirect_blocked' })),
    ).toBe('redirect')
    expect(
      classifyProbeFailure(new WooCommerceApiError('x', 0, UNSAFE_STORE_URL_CODE, { guardReason: 'private_address' })),
    ).toBe('store_url')
    expect(classifyProbeFailure(new WooCommerceApiError('x', 0, INVALID_STORE_URL_CODE))).toBe('store_url')
    expect(classifyProbeFailure(new WooCommerceApiError('WooCommerce request failed: fetch failed', 0))).toBe('unreachable')
    expect(classifyProbeFailure(new WooCommerceApiError('x', 503))).toBe('unreachable')
    expect(classifyProbeFailure(new WooCommerceApiError('x', 400, 'woocommerce_rest_invalid_param'))).toBe('unknown')
    expect(classifyProbeFailure(new Error('boom'))).toBe('unknown')
  })
})

describe('probeFailureMessage', () => {
  const kinds: WooProbeFailureKind[] = [
    'firewall',
    'credentials',
    'not_found',
    'redirect',
    'store_url',
    'unreachable',
    'unknown',
  ]

  it('has Swedish and English copy for every cause, without em or en dashes', () => {
    for (const kind of kinds) {
      const copy = probeFailureMessage(kind)
      expect(copy.sv.length, kind).toBeGreaterThan(20)
      expect(copy.en.length, kind).toBeGreaterThan(20)
      expect(copy.sv + copy.en, kind).not.toMatch(/[–—]/)
    }
  })

  it('tells the merchant what to allow when a firewall blocked us', () => {
    const copy = probeFailureMessage('firewall')
    expect(copy.sv).toContain('/wp-json/wc/v3/')
    expect(copy.sv).toContain('Accounted-WooCommerce')
    expect(copy.en).toContain('/wp-json/wc/v3/')
  })
})

describe('probeFailureLogFields', () => {
  it('carries status, code and response diagnostics for the log line', () => {
    const error = new WooCommerceApiError('WooCommerce API 403', 403, STORE_FIREWALL_CODE, {
      bodyKind: 'html',
      server: 'cloudflare',
      cfRay: 'abc-ARN',
      htmlTitle: 'Just a moment...',
      queryAuth: false,
    })
    expect(probeFailureLogFields(error)).toEqual({
      kind: 'firewall',
      message: 'WooCommerce API 403',
      status: 403,
      wooCode: STORE_FIREWALL_CODE,
      bodyKind: 'html',
      server: 'cloudflare',
      cfRay: 'abc-ARN',
      htmlTitle: 'Just a moment...',
      queryAuth: false,
    })
  })

  it('handles a non-API error', () => {
    expect(probeFailureLogFields(new Error('boom'))).toEqual({ kind: 'unknown', message: 'boom' })
  })
})
