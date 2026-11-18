'use client'

import { base64UrlToBytes, bytesToBase64Url } from '@/lib/auth/webauthn-mfa'

/**
 * The browser half of a security-key ceremony (crm#1448). The server hands
 * over the GoTrue options as JSON; this turns them into what
 * navigator.credentials expects, runs the ceremony and returns the credential
 * as JSON again for /api/auth/mfa/webauthn/verify. The native WebAuthn Level 3
 * parsers and toJSON are used where the browser has them, a small manual
 * codec otherwise.
 */

type JsonOptions = Record<string, unknown>
type JsonCredential = { id: string; rawId: string; type: 'public-key'; response: Record<string, unknown> } & Record<string, unknown>

type ParseFromJson = {
  parseCreationOptionsFromJSON?: (options: JsonOptions) => PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON?: (options: JsonOptions) => PublicKeyCredentialRequestOptions
}

export function browserSupportsWebauthn(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator?.credentials?.create === 'function'
  )
}

function decodeDescriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) return undefined
  return list.map((item: { id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }) => ({
    ...item,
    id: base64UrlToBytes(item.id),
  }))
}

function creationOptions(json: JsonOptions): PublicKeyCredentialCreationOptions {
  const native = (PublicKeyCredential as unknown as ParseFromJson).parseCreationOptionsFromJSON
  if (typeof native === 'function') return native(json)
  const user = json.user as { id: string; name: string; displayName: string }
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(json.challenge as string),
    user: { ...user, id: base64UrlToBytes(user.id) },
    excludeCredentials: decodeDescriptors(json.excludeCredentials),
  }
}

function requestOptions(json: JsonOptions): PublicKeyCredentialRequestOptions {
  const native = (PublicKeyCredential as unknown as ParseFromJson).parseRequestOptionsFromJSON
  if (typeof native === 'function') return native(json)
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBytes(json.challenge as string),
    allowCredentials: decodeDescriptors(json.allowCredentials),
  }
}

function encode(buffer: ArrayBuffer | null | undefined): string | undefined {
  return buffer ? bytesToBase64Url(new Uint8Array(buffer)) : undefined
}

function credentialToJson(credential: PublicKeyCredential): JsonCredential {
  // The browser's own serialiser when it has one. The DOM library types its
  // result differently from version to version, so it is read as ours here.
  const withJson = credential as unknown as { toJSON?: () => unknown }
  if (typeof withJson.toJSON === 'function') return withJson.toJSON() as JsonCredential
  const response = credential.response
  let body: Record<string, unknown>
  if ('attestationObject' in response) {
    const attestation = response as AuthenticatorAttestationResponse
    body = { attestationObject: encode(attestation.attestationObject), clientDataJSON: encode(attestation.clientDataJSON) }
  } else {
    const assertion = response as AuthenticatorAssertionResponse
    body = {
      authenticatorData: encode(assertion.authenticatorData),
      clientDataJSON: encode(assertion.clientDataJSON),
      signature: encode(assertion.signature),
      userHandle: encode(assertion.userHandle),
    }
  }
  return {
    id: credential.id,
    rawId: credential.id,
    type: 'public-key',
    response: body,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
  }
}

/** Register a new key. Null when the user cancelled or the browser refused. */
export async function createWebauthnCredential(publicKey: JsonOptions): Promise<JsonCredential | null> {
  try {
    const credential = await navigator.credentials.create({ publicKey: creationOptions(publicKey) })
    return credential ? credentialToJson(credential as PublicKeyCredential) : null
  } catch {
    // Safe to ignore: a cancelled or timed-out ceremony rejects with a
    // NotAllowedError, which is the user's choice, not a failure; the caller
    // tells them no key was registered.
    return null
  }
}

/** Sign with a registered key. Null when the user cancelled or the browser refused. */
export async function getWebauthnCredential(publicKey: JsonOptions): Promise<JsonCredential | null> {
  try {
    const credential = await navigator.credentials.get({ publicKey: requestOptions(publicKey) })
    return credential ? credentialToJson(credential as PublicKeyCredential) : null
  } catch {
    // Safe to ignore: a cancelled or timed-out ceremony rejects with a
    // NotAllowedError, which is the user's choice, not a failure; the caller
    // tells them no key was used.
    return null
  }
}
