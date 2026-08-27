import { describe, expect, it } from 'vitest';

import {
  buildFortnoxAuthUrl,
  fortnoxConsentScopes,
  fortnoxScopeFlag,
  FORTNOX_DOCUMENT_SCOPES,
  FORTNOX_DOCUMENT_SCOPES_APPROVED,
  FORTNOX_ASSET_SCOPES,
  FORTNOX_ASSET_SCOPES_APPROVED,
} from '../oauth';

describe('Fortnox OAuth scopes', () => {
  // Pins the 2026-08-13 incident fix: the registered Fortnox app does not
  // have the archive/connectfile scopes approved, and requesting a scope the
  // app lacks makes Fortnox reject the authorize request with invalid_scope
  // before the user can even log in. Do not add them back here until the
  // Fortnox Developer Portal registration includes them.
  it('does not request archive or connectfile until the Fortnox app has them approved', () => {
    const url = new URL(
      buildFortnoxAuthUrl({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://accounted.example.test/callback',
      }),
    );
    const scopes = new Set(url.searchParams.get('scope')?.split(' ') ?? []);

    expect(scopes).toContain('bookkeeping');
    expect(scopes).not.toContain('archive');
    expect(scopes).not.toContain('connectfile');
  });

  // The document-import error message is derived from this flag, so that a
  // user is never told to reconnect for a permission the connect request does
  // not ask for. Flipping it here without enabling the scopes in the Fortnox
  // Developer Portal reintroduces the 2026-08-13 invalid_scope outage.
  it('has the document scopes approved in the portal, and names both of them', () => {
    expect(FORTNOX_DOCUMENT_SCOPES_APPROVED).toBe(true);
    expect(FORTNOX_DOCUMENT_SCOPES).toEqual(['archive', 'connectfile']);
  });

  // The whole point of the opt-in consent: this is the only scope list that
  // carries the attachment permissions, and the ordinary connect above still
  // must not, so no customer is asked for an Arkivplats licence to connect.
  it('puts the attachment scopes in the document consent only', () => {
    expect(fortnoxConsentScopes({ documents: true })).toContain('archive');
    expect(fortnoxConsentScopes({ documents: true })).toContain('connectfile');
    expect(fortnoxConsentScopes()).not.toContain('archive');
    expect(fortnoxConsentScopes()).not.toContain('connectfile');
  });

  // The env override exists for self-hosted deployments running their own
  // Fortnox app, whose portal registration differs from hosted's. Unset (or
  // empty, which is how a commented-out .env line arrives) means the hosted
  // default; anything but the string "true" is false, so a typo fails toward
  // not requesting a scope rather than toward invalid_scope at authorize.
  it('lets env override the hosted scope-approval defaults', () => {
    expect(fortnoxScopeFlag(undefined, true)).toBe(true);
    expect(fortnoxScopeFlag(undefined, false)).toBe(false);
    expect(fortnoxScopeFlag('', true)).toBe(true);
    expect(fortnoxScopeFlag('true', false)).toBe(true);
    expect(fortnoxScopeFlag('false', true)).toBe(false);
    expect(fortnoxScopeFlag('yes', true)).toBe(false);
  });

  // The asset register scope is gated on its own portal approval. While the
  // flag is false, no consent may request it: an unapproved scope in the
  // authorize request is rejected with invalid_scope BEFORE login (the same
  // outage mode the document flag above guards against).
  it('keeps the asset scope out of every consent until the portal approves it', () => {
    expect(FORTNOX_ASSET_SCOPES).toEqual(['assets']);
    if (FORTNOX_ASSET_SCOPES_APPROVED) {
      expect(fortnoxConsentScopes()).toContain('assets');
      expect(fortnoxConsentScopes({ documents: true })).toContain('assets');
    } else {
      expect(fortnoxConsentScopes()).not.toContain('assets');
      expect(fortnoxConsentScopes({ documents: true })).not.toContain('assets');
    }
  });

  // Even once the portal registration lands, opting in must never cost the
  // consent its ledger access: the callback overwrites its tokens in place.
  it('keeps a document consent a superset of an ordinary one', () => {
    const withDocuments = fortnoxConsentScopes({ documents: true });
    for (const scope of fortnoxConsentScopes()) {
      expect(withDocuments).toContain(scope);
    }
  });

  it('requests the document scopes only when they are explicitly passed in', () => {
    const url = new URL(
      buildFortnoxAuthUrl(
        {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://accounted.example.test/callback',
        },
        { scopes: ['bookkeeping', ...FORTNOX_DOCUMENT_SCOPES] },
      ),
    );
    const scopes = new Set(url.searchParams.get('scope')?.split(' ') ?? []);

    expect(scopes).toContain('archive');
    expect(scopes).toContain('connectfile');
  });
});
