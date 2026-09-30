import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeDesktopLink,
  claudeTargetsFor,
  copyPromptAndOpen,
  handoffRoute,
  pinCompany,
  startInAi,
  usableClaudeTarget,
  watchForLeave,
} from '../run'

describe('claudeDesktopLink', () => {
  it('opens a Claude Desktop chat or a Cowork task with the prompt filled in', () => {
    expect(claudeDesktopLink('desktop', 'Hitta kvittona som saknas.', true)).toBe('claude://claude.ai/new?q=Hitta%20kvittona%20som%20saknas.')
    expect(claudeDesktopLink('cowork', 'Kör "bookkeep"', true)).toBe('claude://cowork/new?q=K%C3%B6r%20%22bookkeep%22')
  })

  it('opens an empty one without prefill', () => {
    expect(claudeDesktopLink('desktop', 'Kör mitt arbetsflöde X', false)).toBe('claude://claude.ai/new')
    expect(claudeDesktopLink('cowork', 'Kör mitt arbetsflöde X', false)).toBe('claude://cowork/new')
  })
})

describe('claude targets per device', () => {
  it('offers a phone the web only, whatever was remembered', () => {
    expect(claudeTargetsFor(true)).toEqual(['web'])
    expect(usableClaudeTarget('cowork', true)).toBe('web')
    expect(usableClaudeTarget('desktop', true)).toBe('web')
  })

  it('keeps every target and the remembered one on a computer', () => {
    expect(claudeTargetsFor(false)).toEqual(['web', 'desktop', 'cowork'])
    expect(usableClaudeTarget('cowork', false)).toBe('cowork')
  })
})

describe('pinCompany', () => {
  it('keeps the bare prompt for links and appends the company for the clipboard and claude://', () => {
    const prompt = pinCompany('Kör "Kassaprognos".', 'Företaget är Exempel AB (company_id c-1).')
    expect(prompt.bare).toBe('Kör "Kassaprognos".')
    expect(prompt.pinned).toBe('Kör "Kassaprognos". Företaget är Exempel AB (company_id c-1).')
  })
})

describe('handoffRoute', () => {
  it('fills in Claude Desktop and Cowork always: a claude:// link stays on the device', () => {
    expect(handoffRoute('claude', 'desktop', false)).toBe('desktop_link')
    expect(handoffRoute('claude', 'cowork', true)).toBe('desktop_link')
  })

  it('fills in a web chat only with fixed text and copies what a user wrote', () => {
    expect(handoffRoute('claude', 'web', true)).toBe('web_prefill')
    expect(handoffRoute('claude', 'web', false)).toBe('copy')
    expect(handoffRoute('chatgpt', 'web', true)).toBe('web_prefill')
    expect(handoffRoute('grok', 'web', false)).toBe('copy')
  })

  it('never sends another client to Claude Desktop', () => {
    expect(handoffRoute('chatgpt', 'desktop', false)).toBe('copy')
  })
})

function fakeDocument() {
  return Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
}

describe('watchForLeave', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('says nothing opened when the page keeps its focus', async () => {
    const left = watchForLeave(new EventTarget(), fakeDocument(), 1500)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(left).resolves.toBe(false)
  })

  it('sees an app open when the window loses focus', async () => {
    const win = new EventTarget()
    const left = watchForLeave(win, fakeDocument(), 1500)
    await vi.advanceTimersByTimeAsync(400)
    win.dispatchEvent(new Event('blur'))
    await expect(left).resolves.toBe(true)
  })

  it('sees the page hidden, and ignores it becoming visible', async () => {
    const doc = fakeDocument()
    const left = watchForLeave(new EventTarget(), doc, 1500)
    doc.dispatchEvent(new Event('visibilitychange'))
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    await expect(left).resolves.toBe(true)
  })

  it('stops listening once decided', async () => {
    const win = new EventTarget()
    const remove = vi.spyOn(win, 'removeEventListener')
    const left = watchForLeave(win, fakeDocument(), 1500)
    await vi.advanceTimersByTimeAsync(1500)
    await left
    expect(remove).toHaveBeenCalledWith('blur', expect.any(Function))
  })
})

describe('starting a prompt', () => {
  const prompt = { bare: 'Kör "X". (get_task)', pinned: 'Kör "X". (get_task) Företaget är Y AB (company_id c-1).' }
  let opened: string[]
  let writeText: ReturnType<typeof vi.fn>

  function stubBrowser(clipboard: 'ok' | 'refused') {
    opened = []
    writeText = vi.fn(() => clipboard === 'ok' ? Promise.resolve() : Promise.reject(new Error('Document is not focused')))
    const popup = { opener: {}, location: { replace: (url: string) => { opened.push(url) } } }
    const win = Object.assign(new EventTarget(), { open: vi.fn(() => popup), location: { href: '', assign: vi.fn() } })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', fakeDocument())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    return win
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('fills in a web chat with the bare prompt and copies the pinned one as a backup', async () => {
    stubBrowser('ok')
    await expect(startInAi('claude', 'web', prompt, true)).resolves.toBe('prefilled_copied')
    expect(opened).toEqual([`https://claude.ai/new?q=${encodeURIComponent(prompt.bare)}`])
    expect(opened[0]).not.toContain('company_id')
    expect(writeText).toHaveBeenCalledWith(prompt.pinned)
  })

  it('still reports the filled-in chat when the backup copy is refused', async () => {
    stubBrowser('refused')
    await expect(startInAi('chatgpt', 'web', prompt, true)).resolves.toBe('prefilled')
  })

  it('copies what a user wrote, with the company, and opens an empty chat', async () => {
    stubBrowser('ok')
    await expect(startInAi('grok', 'web', prompt, false)).resolves.toBe('copied')
    expect(opened).toEqual(['https://grok.com/'])
    expect(writeText).toHaveBeenCalledWith(prompt.pinned)
  })

  it('reports a copy that failed', async () => {
    stubBrowser('refused')
    await expect(startInAi('claude', 'web', prompt, false)).resolves.toBe('copy_failed')
  })

  it('sends Claude Desktop the pinned prompt and reports it when the app takes focus', async () => {
    vi.useFakeTimers()
    const win = stubBrowser('ok')
    const starting = startInAi('claude', 'cowork', prompt, false)
    expect(win.location.href).toBe(`claude://cowork/new?q=${encodeURIComponent(prompt.pinned)}`)
    win.dispatchEvent(new Event('blur'))
    await expect(starting).resolves.toBe('prefilled')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('reports no app when a Desktop link opens nothing', async () => {
    vi.useFakeTimers()
    stubBrowser('ok')
    const starting = startInAi('claude', 'desktop', prompt, true)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(starting).resolves.toBe('no_app')
  })

  it('copyPromptAndOpen writes the clipboard before the new tab takes focus', async () => {
    stubBrowser('ok')
    const order: string[] = []
    writeText.mockImplementation(() => { order.push('copy'); return Promise.resolve() })
    ;(window.open as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('open'); return { opener: {}, location: { replace: vi.fn() } } })
    await copyPromptAndOpen('p', 'claude', false)
    expect(order).toEqual(['copy', 'open'])
  })
})
