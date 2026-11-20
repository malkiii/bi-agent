/** Numeric text as a JS number only when that is exact; otherwise the engine's text. Shared by SQL drivers. */
export function exactNumber(text: string): number | string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  if (/^-?\d+$/.test(text)) return Number.isSafeInteger(value) ? value : text;
  const digits = text.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length <= 15 ? value : text;
}
