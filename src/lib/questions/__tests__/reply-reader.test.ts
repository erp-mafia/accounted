import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logMock = vi.hoisted(() => ({
  debug: vi.fn<(message: string, ...args: unknown[]) => void>(),
  info: vi.fn<(message: string, ...args: unknown[]) => void>(),
  warn: vi.fn<(message: string, ...args: unknown[]) => void>(),
  error: vi.fn<(message: string, ...args: unknown[]) => void>(),
}))

vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

import {
  REPLY_KINDS,
  REPLY_READER_REPLY_MAX,
  REPLY_READER_SIGNATURE_HEADER,
  REPLY_READER_TIMEOUT_MS,
  hasReplyReader,
  readReply,
  replyReaderSignature,
  type ReadReplyInput,
} from '../reply-reader'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const OTHER_COMPANY = 'c0000000-0000-4000-8000-000000000002'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const URL_OF_READER = 'https://reader.example.test/read'
const SECRET = 'test-secret'
/** 2023-11-14T22:13:20Z, as unix seconds. */
const T = 1700000000

const QUESTION_TEXT = 'Gäller hyran på 12 000 kr kontoret eller lagret?'
const WHY_TEXT = 'Svaret avgör vilket konto hyran bokförs på.'
const REPLY_TEXT = 'Det är nog kontoret, men jag kollar'

type Env = Record<string, string | undefined>

const env = (overrides: Env = {}): Env => ({
  QUESTION_REPLY_READER_URL: URL_OF_READER,
  QUESTION_REPLY_READER_SECRET: SECRET,
  QUESTION_REPLY_READER_COMPANY_IDS: COMPANY,
  ...overrides,
})

const input = (overrides: Partial<ReadReplyInput> = {}): ReadReplyInput => ({
  companyId: COMPANY,
  question: {
    id: QUESTION_ID,
    text: QUESTION_TEXT,
    why: WHY_TEXT,
    options: [
      { id: 'office', label: 'Kontoret' },
      { id: 'storage', label: 'Lagret' },
    ],
  },
  replyText: REPLY_TEXT,
  locale: 'sv',
  ...overrides,
})

const fetchMock = vi.fn<typeof fetch>()

/** An HTTP answer with a JSON body. */
const answers = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

/** What the one request carried. */
function sent(): { url: string; init: RequestInit; headers: Record<string, string>; raw: string } {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0]
  const request: RequestInit = init ?? {}
  return { url: String(url), init: request, headers: request.headers as Record<string, string>, raw: request.body as string }
}

/** Every argument of every log call, as one text. */
const logged = (): string =>
  JSON.stringify([logMock.debug.mock.calls, logMock.info.mock.calls, logMock.warn.mock.calls, logMock.error.mock.calls])

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T * 1000))
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(answers({ kind: 'answer' }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('which companies have a reply reader', () => {
  const notConfigured: Array<[string, Env]> = [
    ['no url', env({ QUESTION_REPLY_READER_URL: undefined })],
    ['an empty url', env({ QUESTION_REPLY_READER_URL: '  ' })],
    ['a url that is not one', env({ QUESTION_REPLY_READER_URL: 'reader.example.test/read' })],
    ['a plain http url on another host', env({ QUESTION_REPLY_READER_URL: 'http://reader.example.test/read' })],
    ['no secret', env({ QUESTION_REPLY_READER_SECRET: undefined })],
    ['an empty secret', env({ QUESTION_REPLY_READER_SECRET: ' ' })],
    ['no company list', env({ QUESTION_REPLY_READER_COMPANY_IDS: undefined })],
    ['an empty company list', env({ QUESTION_REPLY_READER_COMPANY_IDS: '' })],
    ['nothing at all', {}],
  ]

  it.each(notConfigured)('is not configured with %s: null, and nothing is sent', async (_name, environment) => {
    expect(hasReplyReader(COMPANY, environment)).toBe(false)
    await expect(readReply(input(), environment)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logMock.warn).not.toHaveBeenCalled()
  })

  it('is not used for a company that is not in the list', async () => {
    const environment = env({ QUESTION_REPLY_READER_COMPANY_IDS: `${OTHER_COMPANY}, e0000000-0000-4000-8000-00000000000f` })

    expect(hasReplyReader(COMPANY, environment)).toBe(false)
    expect(hasReplyReader(OTHER_COMPANY, environment)).toBe(true)
    await expect(readReply(input(), environment)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the list like the question list switch: `*` for every company, ids in any case, spaces around them', () => {
    expect(hasReplyReader(COMPANY, env({ QUESTION_REPLY_READER_COMPANY_IDS: '*' }))).toBe(true)
    expect(hasReplyReader(OTHER_COMPANY, env({ QUESTION_REPLY_READER_COMPANY_IDS: ' * ' }))).toBe(true)
    expect(hasReplyReader(COMPANY, env({ QUESTION_REPLY_READER_COMPANY_IDS: ` ${OTHER_COMPANY} , ${COMPANY.toUpperCase()} ` }))).toBe(true)
    expect(hasReplyReader(COMPANY.toUpperCase(), env())).toBe(true)
    expect(hasReplyReader(null, env({ QUESTION_REPLY_READER_COMPANY_IDS: '*' }))).toBe(false)
    expect(hasReplyReader(undefined, env({ QUESTION_REPLY_READER_COMPANY_IDS: '*' }))).toBe(false)
  })

  it('takes plain http on a loopback host only', () => {
    expect(hasReplyReader(COMPANY, env({ QUESTION_REPLY_READER_URL: 'http://localhost:8787/read' }))).toBe(true)
    expect(hasReplyReader(COMPANY, env({ QUESTION_REPLY_READER_URL: 'http://127.0.0.1:8787/read' }))).toBe(true)
    expect(hasReplyReader(COMPANY, env({ QUESTION_REPLY_READER_URL: 'http://10.0.0.5:8787/read' }))).toBe(false)
    expect(hasReplyReader(COMPANY, env({ QUESTION_REPLY_READER_URL: 'ftp://reader.example.test/read' }))).toBe(false)
  })

  it('reads the process environment when none is handed in', async () => {
    await expect(readReply(input())).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    vi.stubEnv('QUESTION_REPLY_READER_URL', URL_OF_READER)
    vi.stubEnv('QUESTION_REPLY_READER_SECRET', SECRET)
    vi.stubEnv('QUESTION_REPLY_READER_COMPANY_IDS', '*')

    expect(hasReplyReader(COMPANY)).toBe(true)
    await expect(readReply(input())).resolves.toEqual({ kind: 'answer' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('the signature', () => {
  it('is t=<unix seconds>,v1=<lowercase hex HMAC-SHA256 of "<t>.<raw body>" keyed with the secret>: the fixed vector', () => {
    // secret `test-secret`, t 1700000000, raw body {"a":1}
    expect(replyReaderSignature('{"a":1}', 'test-secret', 1700000000)).toBe(
      't=1700000000,v1=8cb2c3355fca388e9ac2caec004f4d5d7045d74937ab5faad61dc11682247a9f',
    )
  })

  it('changes with the body, the secret and the time', () => {
    const fixed = replyReaderSignature('{"a":1}', 'test-secret', 1700000000)
    expect(replyReaderSignature('{"a":2}', 'test-secret', 1700000000)).not.toBe(fixed)
    expect(replyReaderSignature('{"a":1}', 'other-secret', 1700000000)).not.toBe(fixed)
    expect(replyReaderSignature('{"a":1}', 'test-secret', 1700000001)).not.toBe(fixed)
  })

  it('takes the time of the call, in whole seconds, when none is given', () => {
    vi.setSystemTime(new Date(T * 1000 + 999))
    expect(replyReaderSignature('{"a":1}', 'test-secret')).toBe(replyReaderSignature('{"a":1}', 'test-secret', T))
  })
})

describe('the request', () => {
  it('posts the question and the written reply as JSON, signed over the raw body, and follows no redirect', async () => {
    await readReply(input(), env())

    const { url, init, headers, raw } = sent()
    expect(url).toBe(URL_OF_READER)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(headers).sort()).toEqual(['Content-Type', REPLY_READER_SIGNATURE_HEADER])
    expect(REPLY_READER_SIGNATURE_HEADER).toBe('X-Accounted-Signature')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers[REPLY_READER_SIGNATURE_HEADER]).toBe(replyReaderSignature(raw, SECRET, T))
    expect(headers[REPLY_READER_SIGNATURE_HEADER]).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
  })

  it('carries exactly the version, the company, the question, the reply and the locale', async () => {
    await readReply(input({ locale: 'en' }), env())

    expect(JSON.parse(sent().raw)).toEqual({
      version: 1,
      company_id: COMPANY,
      question: {
        id: QUESTION_ID,
        text: QUESTION_TEXT,
        why: WHY_TEXT,
        options: [
          { id: 'office', label: 'Kontoret' },
          { id: 'storage', label: 'Lagret' },
        ],
      },
      reply: { text: REPLY_TEXT },
      locale: 'en',
    })
  })

  it('sends a question without a why and without options as null and an empty list', async () => {
    await readReply(input({ question: { id: QUESTION_ID, text: QUESTION_TEXT, why: null, options: [] } }), env())

    const body = JSON.parse(sent().raw) as { question: { why: unknown; options: unknown } }
    expect(body.question.why).toBeNull()
    expect(body.question.options).toEqual([])
  })

  it('leaves out anything else a caller hands in beside the named fields', async () => {
    const withMore = {
      ...input(),
      question: { ...input().question, options: [{ id: 'office', label: 'Kontoret', phone: '46701234567' }] },
      userId: 'a0000000-0000-4000-8000-000000000001',
      conversationId: 'conv-1',
    }

    await readReply(withMore, env())

    const { raw } = sent()
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual(['company_id', 'locale', 'question', 'reply', 'version'])
    expect(raw).not.toContain('46701234567')
    expect(raw).not.toContain('a0000000-0000-4000-8000-000000000001')
    expect(raw).not.toContain('conv-1')
  })

  it('signs with the secret without the whitespace around it', async () => {
    await readReply(input(), env({ QUESTION_REPLY_READER_SECRET: `  ${SECRET}\n` }))

    const { headers, raw } = sent()
    expect(headers[REPLY_READER_SIGNATURE_HEADER]).toBe(replyReaderSignature(raw, SECRET, T))
  })
})

describe('the answer', () => {
  it.each(REPLY_KINDS.filter((kind) => kind !== 'question_back'))('reads the kind %s', async (kind) => {
    fetchMock.mockResolvedValue(answers({ kind }))
    await expect(readReply(input(), env())).resolves.toEqual({ kind })
  })

  it('reads a question back with the reader\'s reply', async () => {
    fetchMock.mockResolvedValue(answers({ kind: 'question_back', reply: 'Menar du kontoret på Storgatan?' }))
    await expect(readReply(input(), env())).resolves.toEqual({ kind: 'question_back', reply: 'Menar du kontoret på Storgatan?' })
  })

  it.each(REPLY_KINDS.filter((kind) => kind !== 'question_back'))('ignores a reply beside the kind %s, whatever it is', async (kind) => {
    fetchMock.mockResolvedValueOnce(answers({ kind, reply: 'Text som inte ska användas' }))
    await expect(readReply(input(), env())).resolves.toEqual({ kind })

    fetchMock.mockResolvedValueOnce(answers({ kind, reply: 42, more: { nested: true } }))
    await expect(readReply(input(), env())).resolves.toEqual({ kind })
  })

  const noReply: Array<[string, unknown]> = [
    ['no reply', { kind: 'question_back' }],
    ['an empty reply', { kind: 'question_back', reply: '' }],
    ['a reply of spaces and control characters only', { kind: 'question_back', reply: ' \n\t\u0000 ' }],
    ['a reply that is not text', { kind: 'question_back', reply: 7 }],
    ['a null reply', { kind: 'question_back', reply: null }],
  ]

  it.each(noReply)('gives null for a question back with %s', async (_name, body) => {
    fetchMock.mockResolvedValue(answers(body))
    await expect(readReply(input(), env())).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith('reply not read', expect.objectContaining({ failure: 'invalid_shape', status: 200 }))
  })

  it.each([201, 204, 302, 400, 401, 404, 429, 500, 503])('gives null for HTTP %i, whatever the body says', async (status) => {
    fetchMock.mockResolvedValue(new Response(status === 204 ? null : JSON.stringify({ kind: 'answer' }), { status }))
    await expect(readReply(input(), env())).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith('reply not read', expect.objectContaining({ failure: 'http_status', status }))
  })

  it.each(['', 'not json', '{"kind":"answer"', '<html></html>'])('gives null for a body that is not JSON: %j', async (raw) => {
    fetchMock.mockResolvedValue(new Response(raw, { status: 200 }))
    await expect(readReply(input(), env())).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith('reply not read', expect.objectContaining({ failure: 'invalid_json', status: 200 }))
  })

  const wrongShape: Array<[string, unknown]> = [
    ['an unknown kind', { kind: 'maybe' }],
    ['no kind', { reply: 'Menar du kontoret?' }],
    ['a kind that is not text', { kind: 1 }],
    ['a kind in another case', { kind: 'Answer' }],
    ['a list', [{ kind: 'answer' }]],
    ['a text', 'answer'],
    ['null', null],
  ]

  it.each(wrongShape)('gives null for a body of the wrong shape: %s', async (_name, body) => {
    fetchMock.mockResolvedValue(answers(body))
    await expect(readReply(input(), env())).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith('reply not read', expect.objectContaining({ failure: 'invalid_shape', status: 200 }))
  })
})

describe('the reader\'s reply', () => {
  const reads = async (reply: string): Promise<string | null> => {
    fetchMock.mockResolvedValue(answers({ kind: 'question_back', reply }))
    const reading = await readReply(input(), env())
    return reading?.kind === 'question_back' ? reading.reply : null
  }

  it('loses its control characters, keeps one space per run of whitespace, and is trimmed', async () => {
    expect(await reads('  Menar\u0000 du\r\n\r\n kontoret\t eller    lagret?\u0007\u009f ')).toBe('Menar du kontoret eller lagret?')
    expect(await reads('Rad ett\nRad två')).toBe('Rad ett Rad två')
  })

  it('is cut at 600 characters', async () => {
    expect(REPLY_READER_REPLY_MAX).toBe(600)
    expect(await reads('a'.repeat(600))).toBe('a'.repeat(600))
    expect(await reads('a'.repeat(601))).toBe('a'.repeat(600))
    expect(await reads(`${'ö'.repeat(599)} och mer text efter gränsen`)).toBe('ö'.repeat(599))
  })

  it('is cut between characters, never inside one', async () => {
    const cut = await reads('😀'.repeat(700))
    expect(cut).toBe('😀'.repeat(600))
  })
})

describe('the time limit and failures on the way', () => {
  /** A request that never answers, and ends when it is aborted. */
  const hangs = (): void => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        }),
    )
  }

  it('gives null when no answer came within 8 seconds, and not before', async () => {
    expect(REPLY_READER_TIMEOUT_MS).toBe(8_000)
    hangs()
    let settled: unknown = 'pending'
    const reading = readReply(input(), env()).then((value) => {
      settled = value
      return value
    })

    await vi.advanceTimersByTimeAsync(REPLY_READER_TIMEOUT_MS - 1)
    expect(settled).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await expect(reading).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith(
      'reply not read',
      expect.objectContaining({ companyId: COMPANY, questionId: QUESTION_ID, failure: 'timeout', durationMs: REPLY_READER_TIMEOUT_MS }),
    )
  })

  it('gives null when the answer\'s body stalls past the time limit', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const stalled = new Response(null, { status: 200 })
      vi.spyOn(stalled, 'text').mockImplementation(
        () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
          }),
      )
      return Promise.resolve(stalled)
    })

    const reading = readReply(input(), env())
    await vi.advanceTimersByTimeAsync(REPLY_READER_TIMEOUT_MS)

    await expect(reading).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith('reply not read', expect.objectContaining({ failure: 'timeout' }))
  })

  it('leaves no timer behind after an answer', async () => {
    await readReply(input(), env())
    expect(vi.getTimerCount()).toBe(0)
  })

  const failures: Array<[string, () => void]> = [
    ['the request is refused', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
    ['the request fails with something that is not an error', () => fetchMock.mockRejectedValue('boom')],
    ['the call itself throws', () => fetchMock.mockImplementation(() => { throw new Error('no network') })],
  ]

  it.each(failures)('never throws: null when %s', async (_name, arrange) => {
    arrange()
    await expect(readReply(input(), env())).resolves.toBeNull()
    expect(logMock.warn).toHaveBeenCalledWith('reply not read', expect.objectContaining({ failure: 'transport', status: null }))
  })
})

describe('what is logged', () => {
  it('logs the company, the question, the kind and the duration of a reading', async () => {
    fetchMock.mockImplementation(async () => {
      vi.setSystemTime(new Date(T * 1000 + 250))
      return answers({ kind: 'later' })
    })

    await readReply(input(), env())

    expect(logMock.info).toHaveBeenCalledTimes(1)
    expect(logMock.info).toHaveBeenCalledWith('reply read', { companyId: COMPANY, questionId: QUESTION_ID, durationMs: 250, kind: 'later' })
    expect(logMock.warn).not.toHaveBeenCalled()
  })

  it('never logs the question, the written reply, the reader\'s reply, the secret or the url', async () => {
    const readerReply = 'Menar du kontoret på Storgatan?'
    fetchMock.mockResolvedValueOnce(answers({ kind: 'question_back', reply: readerReply }))
    await readReply(input(), env())
    fetchMock.mockResolvedValueOnce(new Response(`${readerReply} ${REPLY_TEXT}`, { status: 200 }))
    await readReply(input(), env())
    fetchMock.mockResolvedValueOnce(answers({ kind: 'question_back', reply: readerReply }, 500))
    await readReply(input(), env())
    fetchMock.mockRejectedValueOnce(new Error(`${QUESTION_TEXT} ${REPLY_TEXT}`))
    await readReply(input(), env())

    const all = logged()
    expect(logMock.info).toHaveBeenCalledTimes(1)
    expect(logMock.warn).toHaveBeenCalledTimes(3)
    for (const secretText of [QUESTION_TEXT, WHY_TEXT, REPLY_TEXT, readerReply, 'Kontoret', SECRET, URL_OF_READER]) {
      expect(all).not.toContain(secretText)
    }
  })
})
