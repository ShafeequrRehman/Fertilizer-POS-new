// Spells out a whole-rupee amount for the itemized Bill receipt's
// "In Words" line (see ItemizedBillReceipt.tsx) - e.g. 1418 -> "ONE
// THOUSAND FOUR HUNDRED EIGHTEEN". Standard international (thousand/
// million) grouping, good up to just under one billion - more than
// enough for a single order's total. Paise/cents are dropped (a printed
// till receipt's "in words" line is always whole-currency-unit only).

const ONES = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
  'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
  'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
];

const TENS = [
  '', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY',
];

function threeDigitsToWords(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(ONES[Math.floor(n / 100)], 'HUNDRED');
    n %= 100;
  }
  if (n >= 20) {
    const tensWord = TENS[Math.floor(n / 10)];
    const onesWord = ONES[n % 10];
    parts.push(onesWord ? `${tensWord}-${onesWord}` : tensWord);
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(' ');
}

export function numberToWords(value: number): string {
  const n = Math.max(0, Math.round(Math.abs(value || 0)));
  if (n === 0) return 'ZERO';

  const groups: Array<[number, string]> = [
    [1_000_000_000, 'BILLION'],
    [1_000_000, 'MILLION'],
    [1_000, 'THOUSAND'],
    [1, ''],
  ];

  let remaining = n;
  const words: string[] = [];
  for (const [size, label] of groups) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      words.push(threeDigitsToWords(count));
      if (label) words.push(label);
      remaining %= size;
    }
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

// Full "In Words: ..." line as printed on the itemized Bill receipt.
export function amountInWords(value: number, currencyLabel = ''): string {
  const words = numberToWords(value);
  return currencyLabel ? `${currencyLabel} ${words} ONLY.` : `${words} ONLY.`;
}
