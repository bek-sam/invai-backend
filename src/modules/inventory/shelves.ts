const SIZE_BINS = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

/**
 * Default shelf label for a blank: bay letter per style, shelf per color, bin per size,
 * e.g. Gildan 64000 Black M -> "A-03-3". Deterministic so a re-seed gives the same layout.
 */
export function shelfFor(
  b: { styleCode: string; colorCode: string; size: string },
  styles: string[] = ["G64000", "CC1717", "BC3001"],
  colors: string[] = [],
): string {
  const styleIdx = styles.indexOf(b.styleCode);
  const bay = String.fromCharCode(65 + (styleIdx >= 0 ? styleIdx : (hash(b.styleCode) % 20) + 3));
  const colorIdx = colors.indexOf(b.colorCode);
  const shelf = (colorIdx >= 0 ? colorIdx : hash(b.colorCode) % 12) + 1;
  const bin = Math.max(0, SIZE_BINS.indexOf(b.size.toUpperCase())) + 1;
  return `${bay}-${String(shelf).padStart(2, "0")}-${bin}`;
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
