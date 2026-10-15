/**
 * SIE drop widget: registration and wiring. The byte path itself (drop →
 * preflight → import via tools/call with file_content_base64 + sha256) is
 * asserted structurally on the HTML; the sha256/cap semantics live in
 * sie-preflight.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { tools } from '../server'
import { findUiWidget } from '../widgets'
import { SIE_FILE_EXTENSIONS, SIE_FILE_EXTENSIONS_SV } from '@/lib/import/sie-file-extensions'

describe('SIE drop widget', () => {
  const widget = findUiWidget('ui://sie-drop/app.html')

  it('is registered and renders the drop zone', () => {
    expect(widget).toBeDefined()
    expect(widget?.html).toContain('<!DOCTYPE html>')
    expect(widget?.html).toContain('Importera bokföring')
    expect(widget?.html).toContain("addEventListener('drop'")
  })

  it('carries the approval in-card: stage+arm in one click, BFL text on the commit button', () => {
    const html = widget!.html
    expect(html).toContain("callTool('gnubok_approve_pending_operation'")
    // confirmed=true rides the deliberate click on a button whose label IS
    // the irreversibility statement: the human acknowledgment, no default.
    expect(html).toContain('args.confirmed = true')
    expect(html).toContain('Bokför: oåterkalleligt (BFL 5 kap 5 §)')
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

  it('takes the SIE extensions from the shared list (accounted#32)', () => {
    const html = widget!.html
    expect(html).toContain(`accept="${SIE_FILE_EXTENSIONS.join(',')}"`)
    expect(html).toContain(`${JSON.stringify(SIE_FILE_EXTENSIONS)}.some(`)
    expect(html).toContain(`SIE-export (${SIE_FILE_EXTENSIONS_SV})`)
  })

  it('is attached definition-level to gnubok_create_sie_upload', () => {
    const tool = tools.find((t) => t.name === 'gnubok_create_sie_upload')!
    expect((tool as { _meta?: { ui: { resourceUri: string } } })._meta).toEqual({
      ui: { resourceUri: 'ui://sie-drop/app.html' },
    })
  })
})

/**
 * crm#1201: the card imports into the company it was opened for. The card's
 * script runs here in a bare VM with a stub DOM and host bridge, so what is
 * asserted is the arguments the card actually sends, not the HTML text.
 */
describe('SIE drop widget: company binding', async () => {
  const vm = await import('node:vm')
  const html = findUiWidget('ui://sie-drop/app.html')!.html
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))

  const CARD_COMPANY = { company_id: '22222222-2222-4222-8222-222222222222', name: 'Syskonbolaget AB', org_number: '5560000002' }
  const OTHER_COMPANY = { company_id: '11111111-1111-4111-8111-111111111111', name: 'Nuvarande AB', org_number: '5560000001' }

  type Handler = (event: unknown) => void
  interface Stub {
    textContent: string
    innerHTML: string
    disabled: boolean
    hidden: () => boolean
    click: () => void
    fire: (type: string, event?: unknown) => void
  }

  function boot() {
    const posted: Array<{ id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }> = []
    const windowListeners: Record<string, Handler[]> = {}
    const elements = new Map<string, Stub & Record<string, unknown>>()
    const element = (id: string) => {
      let stub = elements.get(id)
      if (!stub) {
        const classes = new Set<string>(['report', 'actions', 'note', 'target'].includes(id) ? ['hidden'] : [])
        const handlers: Record<string, Handler[]> = {}
        stub = {
          textContent: '',
          innerHTML: '',
          disabled: false,
          classList: {
            add: (c: string) => classes.add(c),
            remove: (c: string) => classes.delete(c),
            toggle: (c: string) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
            contains: (c: string) => classes.has(c),
          },
          addEventListener: (type: string, fn: Handler) => {
            ;(handlers[type] ??= []).push(fn)
          },
          click: () => (handlers.click ?? []).forEach((fn) => fn({})),
          hidden: () => classes.has('hidden'),
          fire: (type: string, event: unknown = { preventDefault() {} }) => (handlers[type] ?? []).forEach((fn) => fn(event)),
        }
        elements.set(id, stub)
      }
      return stub
    }
    class FakeFileReader {
      result: ArrayBuffer | null = null
      onload: (() => void) | null = null
      readAsArrayBuffer(file: { bytes: ArrayBuffer }) {
        this.result = file.bytes
        Promise.resolve().then(() => this.onload?.())
      }
    }
    const context = vm.createContext({
      window: {
        parent: { postMessage: (msg: (typeof posted)[number]) => posted.push(msg) },
        addEventListener: (type: string, fn: Handler) => {
          ;(windowListeners[type] ??= []).push(fn)
        },
      },
      document: {
        getElementById: element,
        documentElement: { classList: { add() {}, remove() {} } },
      },
      FileReader: FakeFileReader,
      crypto: { subtle: { digest: async () => new Uint8Array(32).fill(171).buffer } },
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      Uint8Array,
      Map,
      Promise,
    })
    vm.runInContext(script, context)
    const deliver = (data: unknown) => (windowListeners.message ?? []).forEach((fn) => fn({ data }))
    const flush = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    }
    const lastCall = (name: string) => [...posted].reverse().find((m) => m.method === 'tools/call' && m.params?.name === name)
    const dropFile = async () => {
      element('drop').fire('drop', {
        preventDefault() {},
        dataTransfer: { files: [{ name: 'export.se', bytes: new TextEncoder().encode('#FLAGGA 0').buffer }] },
      })
      await flush()
    }
    // Host handshake first, as every MCP Apps host does.
    deliver({ jsonrpc: '2.0', id: posted[0].id, result: {} })
    return { posted, element, deliver, flush, lastCall, dropFile }
  }

  const preflightReply = (target: typeof CARD_COMPANY) => ({
    structuredContent: {
      verdict: 'ok',
      target_company: target,
      file: { company_name: 'Syskonbolaget AB', org_number: '556000-0002', fiscal_year: { start: '2026-01-01', end: '2026-12-31' }, voucher_count: 1, account_count: 2 },
      validation: { valid: true, errors: [], warnings: [], notices: [] },
      mappings: [{ sourceAccount: '1930', targetAccount: '1930' }],
    },
  })

  it('shows the company from the tool result before anything is dropped', () => {
    const card = boot()
    expect(card.element('target').hidden()).toBe(true)
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { upload_id: 'u', target_company: CARD_COMPANY } } })
    expect(card.element('target').hidden()).toBe(false)
    expect(card.element('target').textContent).toBe('Importeras till Syskonbolaget AB (5560000002).')
  })

  it('passes the card company to the preflight and the import', async () => {
    const card = boot()
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { target_company: CARD_COMPANY } } })
    await card.dropFile()

    const preflight = card.lastCall('gnubok_sie_preflight')!
    expect(preflight.params!.arguments).toMatchObject({ company_id: CARD_COMPANY.company_id, filename: 'export.se' })

    card.deliver({ jsonrpc: '2.0', id: preflight.id, result: preflightReply(CARD_COMPANY) })
    await card.flush()
    expect(card.element('actions').hidden()).toBe(false)
    expect(card.element('report').innerHTML).toContain('Importeras till')
    expect(card.element('report').innerHTML).toContain('Syskonbolaget AB (5560000002)')

    card.element('import').click()
    await card.flush()
    expect(card.lastCall('gnubok_import_sie')!.params!.arguments).toMatchObject({ company_id: CARD_COMPANY.company_id })
  })

  it('blocks Importera when the preflight checked another company than the card names', async () => {
    const card = boot()
    card.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { target_company: CARD_COMPANY } } })
    await card.dropFile()
    const preflight = card.lastCall('gnubok_sie_preflight')!

    card.deliver({ jsonrpc: '2.0', id: preflight.id, result: preflightReply(OTHER_COMPANY) })
    await card.flush()
    expect(card.element('actions').hidden()).toBe(true)
    expect(card.element('report').innerHTML).toContain('Fel företag')
    expect(card.element('report').innerHTML).toContain('Kontrollen kördes för Nuvarande AB')
  })

  it('without a tool result it sends no company_id and shows the company the server checked', async () => {
    const card = boot()
    await card.dropFile()
    const preflight = card.lastCall('gnubok_sie_preflight')!
    expect(preflight.params!.arguments).not.toHaveProperty('company_id')

    card.deliver({ jsonrpc: '2.0', id: preflight.id, result: preflightReply(OTHER_COMPANY) })
    await card.flush()
    expect(card.element('report').innerHTML).toContain('Importeras till</span><span class="v">Nuvarande AB (5560000001)')
    expect(card.element('actions').hidden()).toBe(false)
  })
})
