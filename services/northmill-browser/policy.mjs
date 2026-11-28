import { timingSafeEqual } from 'node:crypto'

export const MAX_DOWNLOAD = 10 * 1024 * 1024
export const TTL_MS = 10 * 60 * 1000
export class Refusal extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status }
}
export function authenticated(header, token) {
  const a = Buffer.from(header || ''), b = Buffer.from(`Bearer ${token}`)
  return token?.length >= 32 && a.length === b.length && timingSafeEqual(a, b)
}
export function allowedBankUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'northmill.com' || url.hostname.endsWith('.northmill.com')) &&
      (!url.port || url.port === '443')
  } catch { return false }
}
export function validateOwner(owner) {
  if (typeof owner !== 'string' || !/^[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(owner)) throw new Refusal('INVALID_OWNER')
  return owner
}
export function validCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  return buffer.length <= MAX_DOWNLOAD && /^kontonummer\s*,/i.test(text.trimStart()) &&
    text.split(/\r?\n/).slice(0, 20).some(line => /bokföringsdag/i.test(line) && /beskrivning/i.test(line) && /belopp/i.test(line))
}
