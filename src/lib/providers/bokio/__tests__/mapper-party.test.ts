import { describe, expect, it } from 'vitest';
import { mapBokioToCustomer, mapBokioToSupplier } from '../mapper';

/**
 * The field names and values are Bokio's own (`customer` and `supplier` in
 * its published company-api spec). The mapper looked for a customer type
 * Bokio does not use and for supplier giro numbers where Bokio has none: no
 * imported Bokio customer was private, and 4 of 192 suppliers had a bankgiro
 * (crm#1436).
 */

describe('Bokio customer', () => {
  it('reads type private as a private customer', () => {
    expect(mapBokioToCustomer({ id: 'c1', name: 'Anna Exempel', type: 'private', orgNumber: '19800101-1234' }).type).toBe('private');
    expect(mapBokioToCustomer({ id: 'c2', name: 'Kund AB', type: 'company', orgNumber: '556677-8899' }).type).toBe('company');
  });

  it('takes the default contact, else the first', () => {
    const contactsDetails = [
      { name: 'Bo', email: 'bo@example.test', phone: '08-1', isDefault: false },
      { name: 'Eva', email: 'eva@example.test', phone: '08-2', isDefault: true },
    ];
    expect(mapBokioToCustomer({ id: 'c1', name: 'Kund AB', type: 'company', contactsDetails }).party.contact)
      .toEqual({ name: 'Eva', email: 'eva@example.test', telephone: '08-2' });
    expect(mapBokioToCustomer({ id: 'c1', name: 'Kund AB', type: 'company', contactsDetails: [contactsDetails[0]] }).party.contact)
      .toEqual({ name: 'Bo', email: 'bo@example.test', telephone: '08-1' });
  });
});

describe('Bokio supplier', () => {
  const supplier = (paymentDetails: unknown) => mapBokioToSupplier({
    id: 's1', name: 'Leverantör AB', orgNumber: '556677-8899', vatNumber: 'SE556677889901', currency: 'SEK',
    address: { line1: 'Gatan 1', city: 'Göteborg', postalCode: '123 45', country: 'SE' },
    paymentDetails,
  });

  const payment = (dto: ReturnType<typeof supplier>) => ({
    bankGiro: dto.bankGiro, plusGiro: dto.plusGiro, clearingNumber: dto.clearingNumber, bankAccount: dto.bankAccount,
    iban: dto.iban, bic: dto.bic,
  });
  const none = { bankGiro: undefined, plusGiro: undefined, clearingNumber: undefined, bankAccount: undefined, iban: undefined, bic: undefined };

  it('reads the bankgiro from paymentDetails', () => {
    expect(payment(supplier({ type: 'bankgiro', bankgiroNumber: '1234-5678' }))).toEqual({ ...none, bankGiro: '1234-5678' });
  });

  it('reads the plusgiro from paymentDetails', () => {
    expect(payment(supplier({ type: 'plusgiro', plusgiroNumber: '12345-6' }))).toEqual({ ...none, plusGiro: '12345-6' });
  });

  it('reads a transfer as the clearing and account number', () => {
    expect(payment(supplier({ type: 'transfer', clearingNumber: '8327', accountNumber: '9123456' })))
      .toEqual({ ...none, clearingNumber: '8327', bankAccount: '9123456' });
    expect(payment(supplier({ type: 'transfer', accountNumber: '9123456' }))).toEqual({ ...none, bankAccount: '9123456' });
  });

  it('reads an international payment as the IBAN and BIC', () => {
    expect(payment(supplier({ type: 'internationalPayment', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' })))
      .toEqual({ ...none, iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' });
  });

  it('carries no payment details without paymentDetails', () => {
    for (const details of [undefined, null]) expect(payment(supplier(details))).toEqual(none);
  });

  it('reads the currency the supplier bills in', () => {
    expect(supplier(undefined).currencyCode).toBe('SEK');
  });

  it('keeps the identity, VAT number and address', () => {
    const dto = supplier({ type: 'bankgiro', bankgiroNumber: '1234-5678' });
    expect(dto.vatNumber).toBe('SE556677889901');
    expect(dto.party.identifications).toEqual([{ id: '556677-8899', schemeId: 'SE:ORGNR' }]);
    expect(dto.party.postalAddress).toMatchObject({ streetName: 'Gatan 1', cityName: 'Göteborg', postalZone: '123 45', countryCode: 'SE' });
    expect(dto.party.contact).toBeUndefined();
  });
});
