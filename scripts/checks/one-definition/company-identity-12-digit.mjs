export default {
  rule: 'company-identity-12-digit',
  says: 'The 12-digit identity a filing carries for the company comes from one conversion that reads the legal form.',
  home: 'src/lib/invariants/org-number.ts: toRedovisare12',
  why: 'The AGI generator put 16 on any 10 digits, so a sole trader in 10-digit form was refused and told to enter a 12-digit form the settings door reads as no change, while moms and the OCR built the same firm its birth century.',
  match: [/`16\$\{/],
  sanctioned: ['lib/invariants/org-number.ts'],
  allowed: {
    'lib/bolaget/capital/ku31-xml.ts': 'KU31 takes a legal person only: validateKuCommon refuses anything else before fileOrgNumber writes OrganisationsnummerTYPE.',
    'lib/parties/scb/org-number.ts': "SCB's PeOrgNr of a counterparty, no company of ours and so no legal form, behind isLegalPersonOrgNumber.",
    'lib/invoices/rot-rut-file.ts': 'A brf in the ROT file: always a legal person, and refused unless it reads as one.',
  },
}
