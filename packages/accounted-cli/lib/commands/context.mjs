/**
 * What every command receives. Built once per run in cli.mjs; tests build it
 * directly.
 *
 * @typedef {{
 *   origin: string,
 *   company: string | undefined,
 *   envKey: string | undefined,
 *   flags: { 'no-browser'?: boolean, force?: boolean },
 *   env: Record<string, string | undefined>,
 *   stdin: NodeJS.ReadableStream & { isTTY?: boolean },
 *   platform: string,
 *   headers: Record<string, string>,
 *   store: ReturnType<typeof import('../store.mjs').createStore>,
 *   session: ReturnType<typeof import('../session.mjs').createSession>,
 *   send: typeof import('../http.mjs').send,
 *   openBrowser: (url: string) => boolean,
 *   startLoopback: typeof import('../oauth.mjs').startLoopback,
 *   readPastedLine: typeof import('../oauth.mjs').readPastedLine,
 *   readFile: (path: string) => Promise<Buffer>,
 *   randomBytes: (size: number) => Buffer,
 *   sleep: (ms: number) => Promise<void>,
 *   loginTimeoutMs: number,
 *   out: (value: unknown) => void,
 *   text: (value: string) => void,
 *   err: (value: unknown) => void,
 *   note: (text: string) => void,
 * }} Context
 */

export {}
