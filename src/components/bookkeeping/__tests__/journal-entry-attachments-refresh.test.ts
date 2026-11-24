import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  setters: [] as ReturnType<typeof vi.fn>[],
  read: undefined as undefined | (() => Promise<void>),
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const setter = vi.fn()
    hooks.setters.push(setter)
    return [initial, setter]
  },
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: () => Promise<void>) => { hooks.read = callback; return callback },
  useEffect: () => undefined,
}))
vi.mock('next-intl', () => ({ useLocale: () => 'en', useTranslations: () => (key: string) => key }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/components/ui/viewer-lock', () => ({ useViewerLock: () => ({ canWrite: false }) }))
vi.mock('@/lib/branding/brand-context', () => ({ useBranding: () => ({ appName: 'Accounted' }) }))
import JournalEntryAttachments from '../JournalEntryAttachments'

beforeEach(() => {
  hooks.setters = []
  hooks.read = undefined
})
afterEach(() => vi.unstubAllGlobals())

it.each(['http', 'network'])('ignores an older %s failure after a newer document read succeeds', async failure => {
  let resolve!: (response: unknown) => void
  let reject!: (error: Error) => void
  const oldResponse = new Promise((res, rej) => { resolve = res; reject = rej })
  const fetchMock = vi.fn()
    .mockReturnValueOnce(oldResponse)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
  vi.stubGlobal('fetch', fetchMock)
  JournalEntryAttachments({ journalEntryId: 'entry', references: [] })
  const oldRead = hooks.read!()
  await hooks.read!()
  if (failure === 'http') resolve({ ok: false })
  else reject(new Error('Connection lost'))
  await oldRead
  const setLoadFailed = hooks.setters[2]
  expect(setLoadFailed).toHaveBeenCalledWith(false)
  expect(setLoadFailed).not.toHaveBeenCalledWith(true)
})

it.each(['http', 'network'])('reports a current %s failure instead of treating it as an empty document list', async failure => {
  vi.stubGlobal('fetch', failure === 'http'
    ? vi.fn().mockResolvedValue({ ok: false })
    : vi.fn().mockRejectedValue(new Error('Connection lost')))
  JournalEntryAttachments({ journalEntryId: 'entry', references: [] })
  await hooks.read!()
  expect(hooks.setters[2]).toHaveBeenCalledWith(true)
  expect(hooks.setters[0]).not.toHaveBeenCalled()
})
