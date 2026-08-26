import { describe, expect, it } from 'vitest';
import { mapBokioToCompanyInformation } from '../mapper';

describe('mapBokioToCompanyInformation', () => {
  it('maps the documented company-information v1 fields', () => {
    const result = mapBokioToCompanyInformation({
      id: '9b408943-7a1e-47ac-85a7-ac52b2c210d3',
      name: 'Testbolaget AB',
      organizationNumber: '556677-8899',
      companyType: 'limitedCompany',
      address: {
        line1: 'Testgatan 1',
        city: 'Göteborg',
        postalCode: '123 45',
        country: 'SE',
      },
    });

    expect(result).toMatchObject({
      companyName: 'Testbolaget AB',
      organizationNumber: '556677-8899',
      legalEntity: {
        registrationName: 'Testbolaget AB',
        companyId: '556677-8899',
      },
      address: {
        streetName: 'Testgatan 1',
        cityName: 'Göteborg',
        postalZone: '123 45',
        countryCode: 'SE',
      },
    });
  });
});
