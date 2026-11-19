import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/**
 * The one sentence the settings save bar shows for a refused PUT /api/settings.
 *
 * A validation refusal names the field rules Zod broke, which say more than
 * "Validation failed". Every other refusal is the structured envelope
 * ({ error: { code, message } }); reading `body.error` as if it were a string
 * turned that envelope into "[object Object]", so it goes through the shared
 * mapper whole.
 */
export function settingsSaveErrorMessage(body: unknown, status: number, locale: ErrorLocale): string {
  const validation = body as { type?: unknown; errors?: unknown } | null
  if (validation?.type === 'validation_error' && Array.isArray(validation.errors)) {
    const messages = validation.errors
      .map((issue: { message?: unknown } | null) => issue?.message)
      .filter((message): message is string => typeof message === 'string' && message.length > 0)
    if (messages.length > 0) return messages.join(' • ')
  }
  return getErrorMessage(body, { statusCode: status, locale, context: 'settings' })
}
