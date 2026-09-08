import { readFile, writeFile } from 'node:fs/promises';

const css = await readFile(new URL('./tokens.css', import.meta.url), 'utf8');
const blocks = [...css.matchAll(/(?:^|\n)([^{}]+)\{([^}]+)\}/g)];
const themes = Object.fromEntries(['light', 'dark'].map(theme => {
  const block = blocks.find(([, selector]) => selector.includes(`[data-theme="${theme}"]`));
  return [theme, Object.fromEntries([...block[2].matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(([, key, hex]) => [key, hex]))];
}));
function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const checks = [];
for (const fg of ['text', 'text-dim']) {
  for (const bg of ['bg', 'surface', 'hover', 'accent-bg']) checks.push([fg, bg, 4.5]);
}
for (const bg of ['bg', 'surface', 'hover', 'accent-bg']) checks.push(['accent', bg, 4.5]);
checks.push(['on-accent', 'accent', 4.5]);
for (const state of ['paid', 'pend', 'stop']) {
  // Outlined pills have an opaque surface; filled pills use their semantic fill.
  checks.push([state, `${state}-bg`, 4.5], [state, 'surface', 4.5]);
}
// Overdue text remains directly on the row across hover and selection.
for (const bg of ['hover', 'accent-bg']) checks.push(['stop', bg, 4.5]);
for (const bg of ['surface', 'bg']) checks.push(['border-str', bg, 3]);
const rows = [];
let failed = false;
for (const [fg, bg, minimum] of checks) {
  const values = Object.values(themes).map(t => contrast(t[fg], t[bg]));
  const pass = values.every(v => v >= minimum);
  failed ||= !pass;
  rows.push(`| --${fg} / --${bg} | ${values[0].toFixed(2)}:1 | ${values[1].toFixed(2)}:1 | ${minimum}:1 | ${pass ? 'Pass' : 'FAIL'} |`);
}
const report = `# Colour contrast verification\n\nCalculated from \\tokens.css\\ using the [W3C sRGB luminance definition](https://www.w3.org/TR/WCAG22/#dfn-relative-luminance). All decisions use unrounded ratios; displayed values use two decimals. This checks colour pairs, not full WCAG conformance.\n\n| Foreground / background | Light | Dark | Minimum | Result |\n|---|---:|---:|---:|---|\n${rows.join('\n')}\n\nText requires 4.5:1. Control boundaries require 3:1. The quiet --border separator carries no state or control-boundary meaning. Focus uses --accent and exceeds 3:1 on every supported adjacent surface.\n`;
await writeFile(new URL('./contrast-report.md', import.meta.url), report.replaceAll('\\tokens.css\\', '`tokens.css`'));
console.log(`${checks.length * 2} contrast checks: ${failed ? 'FAILED' : 'PASS'}. Report: docs/design/astra-phase-1/contrast-report.md`);
if (failed) { console.log(rows.filter(r => r.includes('FAIL')).join('\n')); process.exitCode = 1; }
