import { z } from 'zod'

/**
 * The byrå's own customer number for a client company
 * (companies.byra_client_number, crm#1279): free text as the byrå writes it,
 * NULL when unset. The limits mirror companies_byra_client_number_check
 * (migration 20261020083700): trimmed, 1 to 40 characters, one line.
 */
export const CLIENT_NUMBER_MAX_LENGTH = 40

/**
 * Body of PUT /api/clients/:companyId/client-number. Surrounding whitespace
 * is dropped and an empty value clears the number, so the cell in the client
 * list can send whatever the field holds.
 */
export const ClientNumberBodySchema = z.object({
  client_number: z
    .string()
    .trim()
    .max(CLIENT_NUMBER_MAX_LENGTH)
    .refine((value) => !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'One line, no control characters')
    .nullable()
    .transform((value) => (value ? value : null)),
})
