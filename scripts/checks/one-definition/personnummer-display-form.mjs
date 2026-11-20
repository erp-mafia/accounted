export default {
  rule: 'personnummer-display-form',
  says: 'A personnummer is shown one way on every read surface: the birth date visible and the last four digits hidden (YYYYMMDD-XXXX), anything that is not 10 or 12 digits hidden whole.',
  home: 'src/lib/invariants/personal-number-shape.ts: maskPersonnummer',
  why: 'The signing certificate went through a second helper that masked the other way round (XXXXXXXX-1234), so one document showed exactly the four digits every other surface hides (crm#1969).',
  match: [
    // `${digits.slice(0, 8)}-XXXX`: the display form built by hand.
    /\.slice\(0,\s*[68]\)\}-XXXX/,
    // 'XXXXXXXX' in front of the last four digits: the birth date hidden instead.
    /['"`]X{6,8}['"`]/,
  ],
  sanctioned: ['lib/invariants/personal-number-shape.ts'],
  allowed: {
    'lib/auth/bankid.ts':
      'maskPersonalNumber, XXXXXXXX-1234: what the people register of Bolaget stores and shows (its table has a CHECK on that form), and the form a signature is recorded with on a database whose check is not widened yet (lib/signing/ceremony.ts). Whether Bolaget follows the one display form is its own decision.',
  },
}
