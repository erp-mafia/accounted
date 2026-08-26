import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import {
  aiCredentialPrefix,
  createAiClient,
  hasAiCredentials,
  resolveAiProvider,
  toProviderModelId,
} from '../provider'

const AI_ENV_KEYS = [
  'AI_PROVIDER',
  'AI_BASE_URL',
  'AI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
] as const

let saved: Partial<Record<(typeof AI_ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  saved = {}
  for (const key of AI_ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of AI_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('resolveAiProvider', () => {
  it('uses Bedrock when static AWS keys are set (hosted stays unchanged)', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    expect(resolveAiProvider()).toBe('bedrock')
  })

  it('uses the direct API when only an Anthropic key is set (self-hosted)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    expect(resolveAiProvider()).toBe('anthropic')
  })

  // The load-bearing precedence case: an operator who adds an Anthropic key
  // for a side experiment must not silently move production inference out of
  // eu-north-1, which is a deliberate BFL/GDPR posture rather than a default.
  it('prefers Bedrock when both credential sets are present', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    expect(resolveAiProvider()).toBe('bedrock')
  })

  it('lets AI_PROVIDER override the credential-based guess, both ways', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'

    process.env.AI_PROVIDER = 'anthropic'
    expect(resolveAiProvider()).toBe('anthropic')

    process.env.AI_PROVIDER = 'bedrock'
    expect(resolveAiProvider()).toBe('bedrock')
  })

  it('accepts AI_PROVIDER case-insensitively and trimmed', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    process.env.AI_PROVIDER = '  Bedrock '
    expect(resolveAiProvider()).toBe('bedrock')
  })

  it('ignores an unrecognised AI_PROVIDER rather than failing closed', () => {
    process.env.AI_PROVIDER = 'openai'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    expect(resolveAiProvider()).toBe('anthropic')
  })

  // Hosted infrastructure that injects credentials via instance profile / IRSA
  // sets no env vars at all: that must still resolve to Bedrock so the AWS
  // credential provider chain gets its chance.
  it('falls back to Bedrock when nothing is configured', () => {
    expect(resolveAiProvider()).toBe('bedrock')
  })
})

describe('hasAiCredentials', () => {
  it('is true for a complete AWS static key pair', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    expect(hasAiCredentials()).toBe(true)
  })

  it('is false for a half-configured AWS key pair', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    expect(hasAiCredentials()).toBe(false)
  })

  it('is true for an OpenAI-compatible base URL with no key (keyless local server)', () => {
    process.env.AI_BASE_URL = 'http://localhost:11434/v1'
    expect(hasAiCredentials()).toBe(true)
  })

  it('is true for an Anthropic key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    expect(hasAiCredentials()).toBe(true)
  })

  it('is false when nothing is configured', () => {
    expect(hasAiCredentials()).toBe(false)
  })

  // AI_PROVIDER names the backend but does not conjure a credential for it.
  it('is false when AI_PROVIDER names a backend with no key', () => {
    process.env.AI_PROVIDER = 'anthropic'
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    expect(hasAiCredentials()).toBe(false)
  })
})

describe('createAiClient', () => {
  it('builds a Bedrock client when AWS keys are set', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    expect(createAiClient()).toBeInstanceOf(AnthropicBedrock)
  })

  it('builds a direct Anthropic client when only an Anthropic key is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    expect(createAiClient()).toBeInstanceOf(Anthropic)
  })

  it('builds a Bedrock client for the AWS provider chain when nothing is set', () => {
    expect(createAiClient()).toBeInstanceOf(AnthropicBedrock)
  })
})

describe('toProviderModelId', () => {
  it('passes the bare id through for the direct API', () => {
    expect(toProviderModelId('claude-sonnet-5', 'anthropic')).toBe('claude-sonnet-5')
  })

  it('adds the eu inference-profile prefix for Bedrock', () => {
    expect(toProviderModelId('claude-sonnet-5', 'bedrock')).toBe('eu.anthropic.claude-sonnet-5')
  })

  // An operator override may already be written in provider form; prefixing it
  // again would produce eu.anthropic.eu.anthropic.… and 404 at call time.
  it('leaves an already-prefixed id alone', () => {
    expect(toProviderModelId('eu.anthropic.claude-sonnet-5', 'bedrock')).toBe(
      'eu.anthropic.claude-sonnet-5'
    )
    expect(toProviderModelId('anthropic.claude-sonnet-5', 'bedrock')).toBe(
      'anthropic.claude-sonnet-5'
    )
  })

  it('defaults to the environment-resolved provider', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-example'
    expect(toProviderModelId('claude-sonnet-5')).toBe('claude-sonnet-5')
  })
})

describe('aiCredentialPrefix', () => {
  it('returns only the non-secret Anthropic key prefix', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-SECRETSECRETSECRET'
    const prefix = aiCredentialPrefix()
    expect(prefix).toBe('sk-ant-api03')
    expect(prefix).not.toContain('SECRET')
  })

  it('returns only the AWS access-key-id class prefix', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIASECRETSECRET'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    const prefix = aiCredentialPrefix()
    expect(prefix).toBe('AKIA')
    expect(prefix).not.toContain('SECRET')
  })

  it('returns null when nothing is configured', () => {
    expect(aiCredentialPrefix()).toBeNull()
  })
})
