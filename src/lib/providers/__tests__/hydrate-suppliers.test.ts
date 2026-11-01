import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMigrationPage, hydrateSuppliers } from '../provider-data-fetcher';
import type { SupplierDto } from '../dto';

/**
 * Fortnox lists suppliers in a short form, like its customers (crm#1245). The
 * country and the VAT number live only on the supplier itself
 * (/3/suppliers/{n}): of 3,525 suppliers imported from the list, 13 had a
 * country and 11 a VAT number, and 39 that bill in a foreign currency were
 * typed Swedish (crm#1436).
 */

function listResponse(suppliers: Record<string, unknown>[]) {
  return {
    Suppliers: suppliers,
    MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1, '@TotalResources': suppliers.length },
  };
}

// The list form: no Country, no CountryCode, no VATNumber, the phone as Phone.
const LISTED = {
  SupplierNumber: '7',
  Name: 'Lieferant GmbH',
  Address1: 'Hauptstrasse 1',
  City: 'Berlin',
  ZipCode: '10115',
  Email: 'info@example.test',
  Phone: '+49 30 123',
  Active: true,
};

const DETAIL = {
  Supplier: {
    ...LISTED,
    Phone: undefined,
    Phone1: '+49 30 123',
    Country: 'Tyskland',
    CountryCode: 'DE',
    VATNumber: 'DE123456789',
    Comments: 'Betalas i EUR',
    TermsOfPayment: '20',
  },
};

/** The supplier register as the import job reads it: the listed page, then each record's detail form. */
async function listedPage(): Promise<SupplierDto[]> {
  return (await fetchMigrationPage('fortnox', 'token', undefined, 'suppliers', 1)).items as SupplierDto[];
}

async function register(): Promise<SupplierDto[]> {
  return (await hydrateSuppliers('fortnox', 'token', undefined, await listedPage())).suppliers;
}

describe('Fortnox suppliers carry the country and VAT number only their detail form names', () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubFetch(handler: (url: string) => Response) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return handler(url);
    }));
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('reads a listed supplier\'s country, VAT number, phone, note and terms from its detail form', async () => {
    stubFetch((url) => url.includes('/suppliers/7') ? json(DETAIL) : json(listResponse([LISTED])));

    const [supplier] = await register();

    expect(supplier?.party.postalAddress?.countryCode).toBe('DE');
    expect(supplier?.vatNumber).toBe('DE123456789');
    expect(supplier?.party.contact?.telephone).toBe('+49 30 123');
    expect(supplier?.note).toBe('Betalas i EUR');
    expect(supplier?.defaultPaymentTermsDays).toBe(20);
    expect(requested.filter((url) => url.includes('/suppliers/7'))).toHaveLength(1);
  });

  it('keeps the listed supplier when its detail form cannot be read', async () => {
    stubFetch((url) => url.includes('/suppliers/7')
      ? json({ ErrorInformation: { error: 1, message: 'Kan inte hitta leverantören' } }, 404)
      : json(listResponse([LISTED])));

    const suppliers = await register();

    expect(suppliers).toHaveLength(1);
    expect(suppliers[0]?.party.name).toBe('Lieferant GmbH');
    expect(suppliers[0]?.party.contact?.telephone).toBe('+49 30 123');
    expect(suppliers[0]?.vatNumber).toBeUndefined();
  });

  it('reports a supplier the budget did not reach instead of dropping it', async () => {
    stubFetch(() => json(listResponse([LISTED])));
    const listed = await listedPage();
    expect(listed).toHaveLength(1);

    const { suppliers, hydration, unhydratedIds } = await hydrateSuppliers('fortnox', 'token', undefined, listed, 0);

    expect(suppliers).toHaveLength(1);
    expect(hydration).toMatchObject({ needed: 1, hydrated: 0, skippedForBudget: 1, abortedBy: 'budget' });
    expect(unhydratedIds.has('7')).toBe(true);
    expect(requested.some((url) => url.includes('/suppliers/7'))).toBe(false);
  });

  it('asks nothing of a provider whose supplier list is the whole record', async () => {
    stubFetch(() => json({}));
    const listed: SupplierDto = {
      id: 's-1', supplierNumber: 's-1', active: true, party: { name: 'Leverantör AB', identifications: [] }, _raw: { Id: 's-1' },
    };

    const { suppliers, hydration } = await hydrateSuppliers('visma', 'token', undefined, [listed]);

    expect(suppliers).toEqual([listed]);
    expect(hydration.needed).toBe(0);
    expect(requested).toEqual([]);
  });
});
