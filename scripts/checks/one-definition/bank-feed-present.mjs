export default {
  rule: 'bank-feed-present',
  says: 'Bank rows can reach a company when it has an active bank connection or any transaction row already.',
  home: 'src/lib/onboarding/checklist.ts: hasBankFeed',
  why: 'The setup checklist asked this inline while the empty Att göra list asked nothing, so a company that finished onboarding without a bank was told everything was done.',
  match: [
    /[Cc]onnections?\.length\s*>\s*0\s*\|\|\s*\(?\s*\(?\w*[Tt]ransactionCount/,
    /[Tt]ransactionCount\b[^;]*>\s*0\s*\|\|\s*\w*[Cc]onnections?\.length\s*>\s*0/,
  ],
  sanctioned: ['lib/onboarding/checklist.ts'],
}
