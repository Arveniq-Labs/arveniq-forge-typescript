import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAnswer } from '../src/format.js';
import { parseChart, renderChart } from '../src/chart.js';
import { highlightMatches } from '../src/markup.js';

const chart = { type: 'bar', title: 'Revenue', labels: ['Jan', 'Feb'], series: [{ name: 'Actual', values: [120, -20] }] };
test('Markdown supports nested lists, headings, emphasis, quotes, strike, links and literal code', () => {
  const html = formatAnswer('# Heading\n\n1. **Bold** and *italic*\n   - ~~old~~\n\n> Quote\n\n[Docs](https://example.com/docs)\n\n```ts\nconst text = "**literal**";\n```');
  for (const tag of ['<h1>', '<ol>', '<ul>', '<strong>', '<em>', '<s>', '<blockquote>', '<pre>']) assert.ok(html.includes(tag), tag);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /&quot;\*\*literal\*\*&quot;/);
});
test('tables preserve alignment, escaped pipes and code, and live inside a keyboard-focusable scroll region', () => {
  const html = formatAnswer('| Description | Amount |\n| :--- | ---: |\n| Long readable wording with a \\| pipe | `500` |');
  assert.match(html, /class="forgeMarkdownTableScroll" tabindex="0" role="region"/);
  assert.match(html, /<thead>/); assert.match(html, /<tbody>/);
  assert.match(html, /text-align:right/); assert.match(html, /wording with a \| pipe/); assert.match(html, /<code>500<\/code>/);
});
test('raw HTML, images, unsafe/relative URLs and malicious chart labels cannot create executable markup', () => {
  const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const html = formatAnswer(`${payload}\n\n![tracking](https://example.com/pixel)\n[bad](javascript:alert(1))\n[local](/secret)\n[entity](&#106;avascript:alert(1))`);
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('<a '));
  const svg = renderChart(parseChart(JSON.stringify({ ...chart, title: payload, labels: [payload, 'Feb'] })));
  assert.ok(!svg.includes('<img')); assert.ok(!svg.includes('<script')); assert.match(svg, /&lt;img/);
  assert.ok(!svg.includes('href=')); assert.ok(!svg.includes('<foreignObject'));
});
test('bar/line charts handle signed values and zero domains without invalid SVG geometry', () => {
  for (const values of [[120, -20], [0, 0], [-2, -3]]) for (const type of ['bar', 'line']) {
    const html = formatAnswer('```chart\n' + JSON.stringify({ ...chart, type, series: [{ name: 'Series', values }] }) + '\n```');
    assert.match(html, /<svg /); assert.match(html, /View chart data/); assert.ok(!/NaN|Infinity/.test(html));
    assert.ok(type === 'bar' ? html.includes('<rect ') : html.includes('<polyline '));
  }
});
test('pie/doughnut handle a single whole slice and expose exact values in their data table', () => {
  for (const type of ['pie', 'doughnut']) {
    const html = renderChart(parseChart(JSON.stringify({ ...chart, type, series: [{ name: 'Total', values: [3456789.123, 0] }] })));
    assert.match(html, /<circle /); assert.match(html, /<td>3456789\.123<\/td>/); assert.ok(!/NaN|Infinity/.test(html));
  }
});
test('chart validation rejects mismatched, excessive, nonfinite, negative-pie and unsupported data', () => {
  const invalid = [null, { ...chart, type: 'script' }, { ...chart, series: [{ name: 'A', values: [1] }] },
    { ...chart, labels: Array(51).fill('x') }, { ...chart, type: 'pie' }, { ...chart, series: [{ name: 'A', values: [1e15, 1] }] }];
  for (const value of invalid) assert.throws(() => parseChart(JSON.stringify(value)));
  assert.throws(() => parseChart('{"type":"bar","labels":["x"],"series":[{"name":"x","values":[1e999]}]}'));
  assert.throws(() => parseChart('x'.repeat(64_001)));
});
test('streaming chart fences stay pending until closed and invalid completed charts show an escaped fallback', () => {
  assert.match(formatAnswer('```chart\n' + JSON.stringify(chart)), /Preparing chart/);
  assert.ok(!formatAnswer('```chart\n' + JSON.stringify(chart)).includes('<svg'));
  assert.match(formatAnswer('~~~chart\n' + JSON.stringify(chart) + '\n~~~'), /<svg /);
  const html = formatAnswer('```chart\n<img onerror=alert(1)>\n```');
  assert.match(html, /Unable to display/); assert.match(html, /&lt;img/); assert.ok(!html.includes('<img'));
});
test('highlighting ignores case and accents while escaping HTML and merging overlaps', () => {
  assert.equal(highlightMatches('Café <sales>', 'cafe sales'), '<mark>Café</mark> &lt;<mark>sales</mark>&gt;');
  assert.equal(highlightMatches('Revenue', 'rev revenue'), '<mark>Revenue</mark>');
});
test('optional translations retain defaults when undefined and escape host-provided labels', () => {
  const html = formatAnswer('| A | B |\n| --- | --- |\n| 1 | 2 |', { tableLabel: undefined, tableHint: '<img src=x>' });
  assert.match(html, /aria-label="Response table"/); assert.match(html, /&lt;img src=x&gt;/); assert.ok(!html.includes('<img'));
});
