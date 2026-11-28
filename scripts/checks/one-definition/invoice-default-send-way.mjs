export default {
  rule: 'invoice-default-send-way',
  says: "The way an invoice goes out without a pick by hand is the customer's own way (Skickas som) when the invoice can use it, then the company's saved send order, then the editor's default: the order comes from sendOrderForCustomer and resolveEffectiveChannel applies it.",
  home: 'src/lib/invoices/send-order.ts: sendOrderForCustomer',
  why: "Two settings decide one default, the customer's way and the company's order: a reader that takes one of them alone (the editor read only the company's order before customers had a way) picks another channel for the same invoice than the editor does.",
  match: [
    // The company's order handed to the editor default alone, past the customer's way.
    /resolveEffectiveChannel\([^)]*parseSendOrder\(/,
    // An order resolved by hand outside the home.
    /\bdefaultChannelByOrder\s*\(/,
    // The customer's way compared by hand to pick a channel.
    /\binvoice_send_way\s*(?:===|!==)/,
  ],
  sanctioned: ['lib/invoices/send-order.ts', 'lib/invoices/editor/channel.ts'],
}
