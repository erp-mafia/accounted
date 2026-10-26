import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCustomersDirect, hydrateCustomers } from '../provider-data-fetcher';
import type { CustomerDto } from '../dto';

/**
 * Fortnox lists customers in a short form: number, name, org number, address,
 * e-mail and phone. Payment terms, VAT number and the invoice e-mail live only
 * on the customer itself (/3/customers/{n}). A register mapped from the list
 * alone gave every migrated Fortnox customer the 30-day default (crm#1245: a
 * company whose customers paid on 10, 15 and 30 days got 30 on all 478).
 */

function listResponse(customers: Record<string, unknown>[]) {
  return {
    Customers: customers,
    MetaInformation: { '@TotalPages': 1, '@CurrentPage': 1, '@TotalResources': customers.length },
  };
}

// The list form as the migration received it: no TermsOfPayment, no VATNumber.
const LISTED = {
  CustomerNumber: '1001',
  Name: 'Kund AB',
  OrganisationNumber: '556677-8899',
  Address1: 'Gatan 1',
  City: 'Stockholm',
  ZipCode: '111 22',
  Email: 'info@example.test',
  Phone: '08-123 45',
};

function detailFor(customerNumber: string, terms: string) {
  return {
    Customer: {
      ...LISTED,
      CustomerNumber: customerNumber,
      TermsOfPayment: terms,
      VATNumber: 'SE556677889901',
      EmailInvoice: 'faktura@example.test',
      Active: true,
      Type: 'COMPANY',
    },
  };
}

describe('Fortnox customers carry the terms only their detail form names', () => {
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

  it('reads a listed customer\'s payment terms, VAT number and invoice e-mail from its detail form', async () => {
    stubFetch((url) => url.includes('/customers/1001') ? json(detailFor('1001', '10')) : json(listResponse([LISTED])));

    const [customer] = await fetchCustomersDirect('fortnox', 'token');

    expect(customer?.defaultPaymentTermsDays).toBe(10);
    expect(customer?.vatNumber).toBe('SE556677889901');
    expect(customer?.party.contact?.email).toBe('faktura@example.test');
    expect(requested.filter((url) => url.includes('/customers/1001'))).toHaveLength(1);
  });

  it('keeps a stated 0 days (betalning direkt)', async () => {
    stubFetch((url) => url.includes('/customers/1001') ? json(detailFor('1001', '0')) : json(listResponse([LISTED])));

    const [customer] = await fetchCustomersDirect('fortnox', 'token');

    expect(customer?.defaultPaymentTermsDays).toBe(0);
  });

  it('reads the customer from its own record even when the list names its terms (crm#1436)', async () => {
    stubFetch((url) => url.includes('/customers/1001')
      ? json(detailFor('1001', '10'))
      : json(listResponse([{ ...LISTED, TermsOfPayment: '15' }])));

    const [customer] = await fetchCustomersDirect('fortnox', 'token');

    expect(customer?.defaultPaymentTermsDays).toBe(10);
    expect(customer?.vatNumber).toBe('SE556677889901');
    expect(requested.filter((url) => url.includes('/customers/1001'))).toHaveLength(1);
  });

  it('keeps the listed customer when its detail form cannot be read', async () => {
    stubFetch((url) => url.includes('/customers/1001')
      ? json({ ErrorInformation: { error: 1, message: 'Kan inte hitta kunden', code: 2000433 } }, 404)
      : json(listResponse([LISTED])));

    const customers = await fetchCustomersDirect('fortnox', 'token');

    expect(customers).toHaveLength(1);
    expect(customers[0]?.party.name).toBe('Kund AB');
    expect(customers[0]?.defaultPaymentTermsDays).toBeUndefined();
  });

  it('reports a customer the budget did not reach instead of dropping it', async () => {
    stubFetch(() => json(listResponse([LISTED])));
    const listed = await fetchCustomersDirect('fortnox', 'token', undefined, { detailBudgetMs: 0 });
    expect(listed).toHaveLength(1);

    const { customers, hydration, unhydratedIds } = await hydrateCustomers('fortnox', 'token', undefined, listed, 0);

    expect(customers).toHaveLength(1);
    expect(hydration).toMatchObject({ needed: 1, hydrated: 0, skippedForBudget: 1, abortedBy: 'budget' });
    expect(unhydratedIds.has('1001')).toBe(true);
    expect(requested.some((url) => url.includes('/customers/1001'))).toBe(false);
  });

  it('asks nothing of a provider whose customer list already carries the terms', async () => {
    stubFetch(() => json({}));
    const listed: CustomerDto = {
      id: 'c-1', customerNumber: 'c-1', active: true, party: { name: 'Kund AB', identifications: [] }, _raw: { id: 'c-1' },
    };

    const { customers, hydration } = await hydrateCustomers('visma', 'token', undefined, [listed]);

    expect(customers).toEqual([listed]);
    expect(hydration.needed).toBe(0);
    expect(requested).toEqual([]);
  });
});
