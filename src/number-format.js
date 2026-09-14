// Format decimal output without changing the solver's values or exact expressions.
function formatDecimal(value) {
  return String(value).replace(/\d+\.\d+(?:e[+-]?\d+)?/gi, token => {
    const [mantissa, exponent] = token.split(/e/i);
    const number = Number(mantissa);
    const hundredths = Math.round(number * 100) / 100;
    // Never erase small nonzero results or round numbers beyond safe cent precision.
    const rounded = hundredths !== 0 && number < 1e12 && Math.abs(number - hundredths) <= 1e-7
      ? hundredths.toFixed(2) : mantissa;
    const [whole, fraction] = rounded.split('.');
    const significant = fraction.replace(/0+$/, '');
    const formatted = significant ? `${whole}.${significant.padEnd(2, '0')}` : whole;
    return exponent === undefined ? formatted : `${formatted}e${exponent}`;
  });
}

if (typeof module !== 'undefined') module.exports = { formatDecimal };
