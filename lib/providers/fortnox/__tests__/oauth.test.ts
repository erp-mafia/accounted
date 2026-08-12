import { describe, expect, it } from 'vitest';

import { buildFortnoxAuthUrl } from '../oauth';

describe('Fortnox OAuth scopes', () => {
  it('requests archive and file-connection access by default', () => {
    const url = new URL(
      buildFortnoxAuthUrl({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://accounted.example.test/callback',
      }),
    );
    const scopes = new Set(url.searchParams.get('scope')?.split(' ') ?? []);

    expect(scopes).toContain('bookkeeping');
    expect(scopes).toContain('archive');
    expect(scopes).toContain('connectfile');
  });
});
