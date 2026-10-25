/**
 * The TIC side of BankID signing: the `services` the core signing ceremony
 * resolves through the extension registry (contract and rules:
 * lib/signing/bankid-provider.ts).
 *
 * Each call answers a result instead of throwing, and keeps TIC's handout
 * rule here: the poll that sees a sign session complete collects the
 * signature at once (or takes it from the poll itself), because TIC hands a
 * completed result out at most twice (#2471). A session TIC no longer knows,
 * or whose result it already handed out, answers `gone`.
 */
import type {
  BankIdSignPoll,
  BankIdSignStartInput,
  BankIdSignStarted,
  BankIdSigningFailure,
  BankIdSigningResult,
  BankIdSigningServices,
  CollectedBankIdSignature,
} from '@/lib/signing/bankid-provider'
import { cancelBankIdSession, collectBankIdResult, pollBankIdSession, startBankIdSign } from './bankid-client'
import type { BankIdSignatureData, BankIdUser } from './bankid-types'
import { TICAPIError } from './tic-types'

function failure(error: unknown): BankIdSigningFailure {
  if (error instanceof TICAPIError) {
    if (error.code === 'NOT_CONFIGURED') return { ok: false, code: 'NOT_CONFIGURED' }
    if (error.code === 'RATE_LIMIT_EXCEEDED') return { ok: false, code: 'RATE_LIMITED', httpStatus: 429 }
    if (error.code === 'TIMEOUT') return { ok: false, code: 'TIMEOUT' }
    return { ok: false, code: 'PROVIDER_ERROR', ...(error.statusCode ? { httpStatus: error.statusCode } : {}) }
  }
  return { ok: false, code: 'PROVIDER_ERROR' }
}

/** A 404 or 410 from TIC: the session no longer exists there. */
function isGoneError(error: unknown): boolean {
  return error instanceof TICAPIError && (error.statusCode === 404 || error.statusCode === 410)
}

function collected(
  user: BankIdUser | undefined,
  signature: BankIdSignatureData | undefined,
  completedAt: string | undefined,
): CollectedBankIdSignature | null {
  if (!user?.personalNumber || !signature?.value || !signature.ocspResponse || !completedAt) return null
  return {
    personalNumber: user.personalNumber,
    givenName: user.givenName,
    surname: user.surname,
    name: user.name,
    completedAt,
    signatureXml: signature.value,
    ocspResponse: signature.ocspResponse,
  }
}

export async function startBankIdSignature(input: BankIdSignStartInput): Promise<BankIdSigningResult<BankIdSignStarted>> {
  try {
    const session = await startBankIdSign({
      endUserIp: input.endUserIp,
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
      userVisibleData: input.userVisibleData,
      userVisibleDataFormat: 'simpleMarkdownV1',
      userNonVisibleData: input.userNonVisibleData,
      ...(input.personalNumber ? { personalNumber: input.personalNumber } : {}),
    })
    return {
      ok: true,
      data: {
        sessionId: session.sessionId,
        autoStartToken: session.autoStartToken,
        qrStartToken: session.qrStartToken,
        qrStartSecret: session.qrStartSecret,
        expiresAt: session.sessionExpiresAt,
      },
    }
  } catch (error) {
    return failure(error)
  }
}

export async function pollBankIdSignature(sessionId: string): Promise<BankIdSigningResult<BankIdSignPoll>> {
  try {
    const poll = await pollBankIdSession(sessionId)
    // A 410 answers TIC's error body verbatim, without a status.
    switch (poll.status) {
      case 'pending':
        return {
          ok: true,
          data: {
            status: 'pending',
            hintCode: poll.hintCode ?? null,
            qrStartToken: poll.qrStartToken ?? null,
            qrStartSecret: poll.qrStartSecret ?? null,
          },
        }
      case 'failed':
        return { ok: true, data: { status: 'failed', hintCode: poll.hintCode ?? null } }
      case 'cancelled':
        return { ok: true, data: { status: 'cancelled' } }
      case 'complete': {
        const fromPoll = collected(poll.user, poll.signature, poll.completedAt)
        if (fromPoll) return { ok: true, data: { status: 'complete', signature: fromPoll } }
        const collect = await collectBankIdResult(sessionId)
        const fromCollect = collect.status === 'complete'
          ? collected(collect.user ?? poll.user, collect.signature, collect.completedAt ?? poll.completedAt)
          : null
        return { ok: true, data: fromCollect ? { status: 'complete', signature: fromCollect } : { status: 'gone' } }
      }
      default:
        return { ok: true, data: { status: 'gone' } }
    }
  } catch (error) {
    if (isGoneError(error)) return { ok: true, data: { status: 'gone' } }
    return failure(error)
  }
}

export async function cancelBankIdSignature(sessionId: string): Promise<BankIdSigningResult<null>> {
  try {
    await cancelBankIdSession(sessionId)
    return { ok: true, data: null }
  } catch (error) {
    // Cancelling a session TIC already dropped is done.
    if (isGoneError(error)) return { ok: true, data: null }
    return failure(error)
  }
}

export const bankIdSigningServices: BankIdSigningServices = {
  startBankIdSignature,
  pollBankIdSignature,
  cancelBankIdSignature,
}
