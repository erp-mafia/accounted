import { describe, expect, it } from 'vitest';

import { buildFortnoxAuthUrl } from '../oauth';

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
});
