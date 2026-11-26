export default {
  rule: 'customer-edit-form-values',
  says: "The customer card's edit form starts from every field it submits, read from the full stored row; a field it is not given is saved as a clear.",
  home: 'src/lib/customers/customer-form-initial-data.ts: customerFormInitialData',
  why: "The customer page handed the form its starting values field by field and left out the contact person and the copy lists, so every save of the card wiped them.",
  match: [
    // A customer row's field handed on under its own name, absent as
    // undefined: the shape of an edit form's starting values.
    /\b(\w+)\s*:\s*(?:[\w$]+\??\.)*customers?\??\.\1\s*(?:\|\||\?\?)\s*undefined\b/,
  ],
  sanctioned: ['lib/customers/customer-form-initial-data.ts'],
}
