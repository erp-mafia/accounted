/**
 * SIE drop widget: registration and wiring. The byte path itself (drop →
 * preflight → import via tools/call with file_content_base64 + sha256) is
 * asserted structurally on the HTML; the sha256/cap semantics live in
 * sie-preflight.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { tools } from '../server'
import { findUiWidget } from '../widgets'

describe('SIE drop widget', () => {
  const widget = findUiWidget('ui://sie-drop/app.html')

  it('is registered and renders the drop zone', () => {
    expect(widget).toBeDefined()
    expect(widget?.html).toContain('<!DOCTYPE html>')
    expect(widget?.html).toContain('Importera bokföring')
    expect(widget?.html).toContain("addEventListener('drop'")
  })

  it('passes exact bytes through tools/call with a sha256, never retyped or fetched', () => {
    const html = widget!.html
    expect(html).toContain("callTool('gnubok_sie_preflight'")
    expect(html).toContain("callTool('gnubok_import_sie'")
    expect(html).toContain('file_content_base64')
    expect(html).toContain('sha256')
    expect(html).toContain("crypto.subtle.digest('SHA-256'")
    // No network from the iframe: bytes travel via the host bridge only.
    expect(html).not.toContain('fetch(')
    expect(html).not.toContain('XMLHttpRequest')
  })

  it('performs the ui/initialize handshake and narrates via ui/updateContext', () => {
    const html = widget!.html
    expect(html).toContain("sendRequest('ui/initialize'")
    expect(html).toContain("sendNotification('ui/notifications/initialized')")
    expect(html).toContain("sendNotification('ui/updateContext'")
  })

  it('is attached definition-level to gnubok_create_sie_upload', () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_sie_upload')!
    expect((tool as { _meta?: { ui: { resourceUri: string } } })._meta).toEqual({
      ui: { resourceUri: 'ui://sie-drop/app.html' },
    })
  })
})
