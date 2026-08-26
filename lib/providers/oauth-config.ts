import type { OAuthConfig } from './types';

export function getOAuthConfig(provider: string): OAuthConfig {
  if (provider === 'fortnox') {
    return {
      clientId: process.env.FORTNOX_CLIENT_ID ?? '',
      clientSecret: process.env.FORTNOX_CLIENT_SECRET ?? '',
      redirectUri: process.env.FORTNOX_REDIRECT_URI ?? '',
    };
  }
  if (provider === 'visma') {
    return {
      clientId: process.env.VISMA_CLIENT_ID ?? '',
      clientSecret: process.env.VISMA_CLIENT_SECRET ?? '',
      redirectUri: process.env.VISMA_REDIRECT_URI ?? '',
    };
  }
  if (provider === 'briox') {
    // No app-level credentials: the user's account ID + application token are
    // exchanged per consent (exchangeBrioxCode). No env vars needed.
    return {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    };
  }
  if (provider === 'bokio') {
    return {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    };
  }
  if (provider === 'bjornlunden') {
    return {
      clientId: process.env.BJORN_LUNDEN_CLIENT_ID ?? '',
      clientSecret: process.env.BJORN_LUNDEN_CLIENT_SECRET ?? '',
      redirectUri: '',
    };
  }
  if (provider === 'wint') {
    // No app-level credentials: WINT has no OAuth. The user's login is
    // exchanged once for a token pair at submit (loginWint). No env vars.
    return {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

export function validateProvider(provider: string): boolean {
  return provider === 'fortnox' || provider === 'visma' || provider === 'briox' || provider === 'bokio' || provider === 'bjornlunden' || provider === 'wint';
}
