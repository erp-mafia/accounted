import { describe, it, expect } from 'vitest';
import {
  mapWintToSalesInvoice,
  mapWintToCustomer,
  mapWintToAccountingAccount,
  mapWintToCompanyInformation,
} from '../mapper';

describe('WINT mappers', () => {
  describe('mapWintToSalesInvoice', () => {
    const base = {
      Id: 42,
      SerialNumber: 1007,
      Status: 'Unpaid',
      PaymentState: 'Unpaid',
      CreditStatus: 'Regular',
      PostingDate: '2026-03-01T00:00:00',
      DueDate: '2026-03-31T00:00:00',
      Currency: 'SEK',
      TotalAmount: 1250,
      TotalTax: 250,
      LeftToPay: 1250,
      CustomerName: 'Kund AB',
      CustomerOrgNo: '556677-8899',
      Rows: [
        { Id: 1, Description: 'Konsulttimmar', Quantity: 10, UnitPrice: 100, Vat: 25 },
      ],
    };

    it('maps identity, dates and amounts', () => {
      const dto = mapWintToSalesInvoice(base);

      expect(dto.id).toBe('42');
      expect(dto.invoiceNumber).toBe('1007');
      expect(dto.issueDate).toBe('2026-03-01');
      expect(dto.dueDate).toBe('2026-03-31');
      expect(dto.status).toBe('sent');
      expect(dto.legalMonetaryTotal.payableAmount.value).toBe(1250);
      expect(dto.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1000);
      expect(dto.taxTotal?.taxAmount.value).toBe(250);
      expect(dto.customer.name).toBe('Kund AB');
      expect(dto.customer.identifications[0]?.id).toBe('556677-8899');
      expect(dto.lines[0]?.lineExtensionAmount.value).toBe(1000);
    });

    it('derives paid from Status/PaymentState, never from an absent LeftToPay', () => {
      expect(mapWintToSalesInvoice({ ...base, Status: 'Paid' }).status).toBe('paid');
      expect(mapWintToSalesInvoice({ ...base, PaymentState: 'Paid' }).paymentStatus.paid).toBe(true);

      // Absent LeftToPay must read as fully unpaid, not paid
      const { LeftToPay: _omitted, ...withoutLeftToPay } = base;
      const dto = mapWintToSalesInvoice(withoutLeftToPay);
      expect(dto.paymentStatus.paid).toBe(false);
      expect(dto.paymentStatus.balance.value).toBe(1250);
    });

    it('maps overdue and cancelled and credited states', () => {
      expect(mapWintToSalesInvoice({ ...base, PaymentState: 'Overdue' }).status).toBe('overdue');
      expect(mapWintToSalesInvoice({ ...base, Status: 'Collection' }).status).toBe('overdue');
      expect(mapWintToSalesInvoice({ ...base, Status: 'Cancelled' }).status).toBe('cancelled');
      expect(mapWintToSalesInvoice({ ...base, CreditStatus: 'Credited' }).status).toBe('credited');
      expect(mapWintToSalesInvoice({ ...base, Status: 'NotSent' }).status).toBe('draft');
    });

    it('forces balance to 0 when paid', () => {
      const dto = mapWintToSalesInvoice({ ...base, Status: 'Paid', LeftToPay: 1250 });
      expect(dto.paymentStatus.balance.value).toBe(0);
    });

    it('prefers overridden row description, price and VAT', () => {
      const dto = mapWintToSalesInvoice({
        ...base,
        Rows: [{
          Id: 1, Description: 'Bas', OverriddenDescription: 'Justerad',
          Quantity: 2, UnitPrice: 100, OverriddenUnitPrice: 90,
          Vat: 25, OverriddenVat: 12,
        }],
      });
      expect(dto.lines[0]?.description).toBe('Justerad');
      expect(dto.lines[0]?.unitPrice?.value).toBe(90);
      expect(dto.lines[0]?.lineExtensionAmount.value).toBe(180);
      expect(dto.lines[0]?.taxPercent).toBe(12);
    });
  });

  describe('mapWintToCustomer', () => {
    it('maps identity, type, addresses and contact', () => {
      const dto = mapWintToCustomer({
        Id: 7,
        Name: 'Kund AB',
        OrgNumber: '556677-8899',
        Type: 'Company',
        VatNumber: 'SE556677889901',
        PaymentTerms: 30,
        EmailAddress: 'faktura@kund.se',
        PhoneNumber: '070-1234567',
        BillingAddress: { Street1: 'Storgatan 1', ZipCode: '111 22', City: 'Stockholm', CountryCode: 'SE' },
        Inactive: false,
      });

      expect(dto.id).toBe('7');
      expect(dto.type).toBe('company');
      expect(dto.active).toBe(true);
      expect(dto.vatNumber).toBe('SE556677889901');
      expect(dto.defaultPaymentTermsDays).toBe(30);
      expect(dto.party.postalAddress?.streetName).toBe('Storgatan 1');
      expect(dto.party.contact?.email).toBe('faktura@kund.se');
      expect(dto.party.legalEntity?.companyId).toBe('556677-8899');
    });

    it('maps PrivatePerson and Inactive', () => {
      const dto = mapWintToCustomer({ Id: 8, Name: 'Anna', Type: 'PrivatePerson', Inactive: true });
      expect(dto.type).toBe('private');
      expect(dto.active).toBe(false);
    });
  });

  describe('mapWintToAccountingAccount', () => {
    it('stringifies the integer account number and classifies by range', () => {
      const dto = mapWintToAccountingAccount({ Id: 'a1', Name: 'Företagskonto', Number: 1930, SRU: 7281, Ib: 50000.505 });

      expect(dto.accountNumber).toBe('1930');
      expect(typeof dto.accountNumber).toBe('string');
      expect(dto.type).toBe('asset');
      expect(dto.sruCode).toBe('7281');
      expect(dto.balanceBroughtForward).toBe(50000.51);
    });

    it('classifies revenue, expense, equity and financial-income ranges', () => {
      expect(mapWintToAccountingAccount({ Number: 3010, Name: 'Försäljning' }).type).toBe('revenue');
      expect(mapWintToAccountingAccount({ Number: 4010, Name: 'Inköp' }).type).toBe('expense');
      expect(mapWintToAccountingAccount({ Number: 2440, Name: 'Leverantörsskulder' }).type).toBe('liability');
      // 20xx is eget kapital, not a liability
      expect(mapWintToAccountingAccount({ Number: 2081, Name: 'Aktiekapital' }).type).toBe('equity');
      expect(mapWintToAccountingAccount({ Number: 2099, Name: 'Årets resultat' }).type).toBe('equity');
      // 21xx obeskattade reserver stays at liability granularity
      expect(mapWintToAccountingAccount({ Number: 2110, Name: 'Periodiseringsfond' }).type).toBe('liability');
      // 83xx is financial income, not an expense
      expect(mapWintToAccountingAccount({ Number: 8310, Name: 'Ränteintäkter' }).type).toBe('revenue');
      expect(mapWintToAccountingAccount({ Number: 8410, Name: 'Räntekostnader' }).type).toBe('expense');
      expect(mapWintToAccountingAccount({ Number: 8999, Name: 'Årets resultat' }).type).toBe('expense');
    });
  });

  describe('mapWintToCompanyInformation', () => {
    it('maps GET /api/Auth company info', () => {
      const dto = mapWintToCompanyInformation({
        Id: 123,
        Name: 'Bolaget AB',
        Org: '556699-0011',
        Url: 'https://bolaget.se',
        FinancialYears: [{ Id: 1, Start: '2026-01-01T00:00:00', End: '2026-12-31T00:00:00' }],
      });

      expect(dto.companyName).toBe('Bolaget AB');
      expect(dto.organizationNumber).toBe('556699-0011');
      expect(dto.fiscalYearStart).toBe('2026-01-01');
      expect(dto.baseCurrency).toBe('SEK');
    });
  });
});
