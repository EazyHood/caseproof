// Deliberately narrow currency support; adding a currency requires its exponent.
export const CURRENCY_EXPONENTS = Object.freeze({ USD: 2, EUR: 2, GBP: 2 });

export function toMinor(value, currency) {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) throw new TypeError('Unsupported currency; this spike supports USD, EUR and GBP.');
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) {
    throw new TypeError('Money must be a non-negative decimal string with at most two decimals.');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(exponent, '0'));
}

export function fromMinor(minor, currency) {
  if (CURRENCY_EXPONENTS[currency] === undefined) throw new TypeError('Unsupported currency.');
  const amount = BigInt(minor);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
