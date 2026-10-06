import { escapeHtml } from './markup';

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'doughnut';
  title?: string;
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}
const palette = ['#0070f2', '#16837a', '#9564cc', '#e76500', '#cc3d78', '#697a8c'];
const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard' }).format(value);
const coordinate = (value: number) => value.toFixed(3);
function label(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length <= maximum; }
/** Reject executable configs, oversized data, non-finite numbers and mismatched label/value lengths. */
export function parseChart(source: string): ChartSpec {
  if (source.length > 64_000) throw new Error('Chart data is too large.');
  const value = JSON.parse(source) as ChartSpec;
  if (!value || !['bar', 'line', 'pie', 'doughnut'].includes(value.type) || (value.title !== undefined && !label(value.title, 160)) ||
    !Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 50 || !value.labels.every(item => label(item, 100)) ||
    !Array.isArray(value.series) || value.series.length < 1 || value.series.length > 6 || !value.series.every(item =>
      item && label(item.name, 100) && Array.isArray(item.values) && item.values.length === value.labels.length &&
      item.values.every(point => typeof point === 'number' && Number.isFinite(point) && Math.abs(point) <= 1e12))) {
    throw new Error('Use a chart type, labels, and equally sized numeric series.');
  }
  if (['pie', 'doughnut'].includes(value.type) && (value.series.length !== 1 || value.series[0]!.values.some(point => point < 0) || value.series[0]!.values.every(point => point === 0)))
    throw new Error('Pie and doughnut charts need one series of nonnegative values with a positive total.');
  // Copy only the supported data; model-supplied options, HTML, URLs and callbacks never reach the renderer.
  return { type: value.type, title: value.title, labels: value.labels.slice(), series: value.series.map(item => ({ name: item.name, values: item.values.slice() })) };
}
export function renderChart(spec: ChartSpec, dataLabel = 'View chart data'): string {
  const title = spec.title || `${spec.type[0]!.toUpperCase()}${spec.type.slice(1)} chart`;
  const pie = ['pie', 'doughnut'].includes(spec.type);
  const drawing = pie ? renderPie(spec) : renderCartesian(spec);
  const legend = pie ? spec.labels : spec.series.map(series => series.name);
  const legendHtml = legend.map((name, index) => `<span class="forgeChartLegendItem"><i style="background:${palette[index % palette.length]}"></i>${escapeHtml(name)}</span>`).join('');
  const table = `<table><thead><tr><th scope="col">Category</th>${spec.series.map(series => `<th scope="col">${escapeHtml(series.name)}</th>`).join('')}</tr></thead><tbody>` +
    spec.labels.map((name, index) => `<tr><th scope="row">${escapeHtml(name)}</th>${spec.series.map(series => `<td>${escapeHtml(String(series.values[index]!))}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
  return `<figure class="forgeChart"><figcaption>${escapeHtml(title)}</figcaption><div class="forgeChartPlot" tabindex="0" role="region" aria-label="${escapeHtml(title)}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 330" role="img" aria-label="${escapeHtml(title + ' — ' + spec.type + ' chart')}"><title>${escapeHtml(title)}</title>${drawing}</svg></div>` +
    `<div class="forgeChartLegend">${legendHtml}</div><details><summary>${escapeHtml(dataLabel)}</summary><div class="forgeMarkdownTableScroll" tabindex="0" role="region" aria-label="${escapeHtml(title + ' data')}">${table}</div></details></figure>`;
}
function renderCartesian(spec: ChartSpec): string {
  const values = spec.series.flatMap(series => series.values);
  let minimum = Math.min(0, ...values); let maximum = Math.max(0, ...values);
  if (minimum === maximum) maximum = minimum + 1;
  const range = maximum - minimum; minimum -= range * (minimum < 0 ? 0.08 : 0); maximum += range * (maximum > 0 ? 0.08 : 0);
  const left = 80; const top = 20; const width = 610; const height = 240;
  const y = (value: number) => top + height - (value - minimum) / (maximum - minimum) * height;
  let html = '';
  for (let step = 0; step <= 5; step++) {
    const value = minimum + (maximum - minimum) * step / 5; const position = y(value);
    html += `<line x1="${left}" x2="${left + width}" y1="${coordinate(position)}" y2="${coordinate(position)}" class="forgeChartGrid"/><text x="${left - 12}" y="${coordinate(position + 4)}" text-anchor="end">${escapeHtml(number(value))}</text>`;
  }
  html += `<line x1="${left}" x2="${left + width}" y1="${coordinate(y(0))}" y2="${coordinate(y(0))}" class="forgeChartAxis"/>`;
  const group = width / spec.labels.length;
  const x = (index: number) => spec.type === 'bar' ? left + (index + 0.5) * group : left + (spec.labels.length === 1 ? width / 2 : index * width / (spec.labels.length - 1));
  const labelStep = Math.ceil(spec.labels.length / 8);
  spec.labels.forEach((name, index) => {
    if (index % labelStep === 0 || index === spec.labels.length - 1) {
      const short = name.length > 14 ? name.slice(0, 13) + '…' : name;
      html += `<text x="${coordinate(x(index))}" y="292" text-anchor="middle"><title>${escapeHtml(name)}</title>${escapeHtml(short)}</text>`;
    }
  });
  spec.series.forEach((series, seriesIndex) => {
    const color = palette[seriesIndex % palette.length]!;
    if (spec.type === 'line') html += `<polyline points="${series.values.map((value, index) => `${coordinate(x(index))},${coordinate(y(value))}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3"/>`;
    series.values.forEach((value, index) => {
      const tooltip = escapeHtml(`${series.name} · ${spec.labels[index]}: ${number(value)}`);
      if (spec.type === 'bar') {
        const barWidth = group * 0.72 / spec.series.length;
        const barX = left + index * group + group * 0.14 + seriesIndex * barWidth;
        const barY = Math.min(y(value), y(0));
        html += `<rect x="${coordinate(barX)}" y="${coordinate(barY)}" width="${coordinate(Math.max(0.5, barWidth - 2))}" height="${coordinate(Math.max(0.5, Math.abs(y(value) - y(0))))}" rx="2" fill="${color}"><title>${tooltip}</title></rect>`;
      } else html += `<circle cx="${coordinate(x(index))}" cy="${coordinate(y(value))}" r="4" fill="${color}"><title>${tooltip}</title></circle>`;
    });
  });
  return html;
}
function renderPie(spec: ChartSpec): string {
  const values = spec.series[0]!.values; const total = values.reduce((sum, value) => sum + value, 0);
  const cx = 360; const cy = 160; const radius = 135; let angle = -Math.PI / 2; let html = '';
  values.forEach((value, index) => {
    if (!value) return;
    const sweep = value / total * Math.PI * 2; const next = angle + sweep;
    const tooltip = escapeHtml(`${spec.labels[index]}: ${number(value)} (${number(value / total * 100)}%)`);
    const color = palette[index % palette.length]!;
    if (sweep >= Math.PI * 2 - 1e-9) html += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"><title>${tooltip}</title></circle>`;
    else html += `<path d="M ${cx} ${cy} L ${coordinate(cx + Math.cos(angle) * radius)} ${coordinate(cy + Math.sin(angle) * radius)} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${coordinate(cx + Math.cos(next) * radius)} ${coordinate(cy + Math.sin(next) * radius)} Z" fill="${color}"><title>${tooltip}</title></path>`;
    angle = next;
  });
  if (spec.type === 'doughnut') html += `<circle cx="${cx}" cy="${cy}" r="78" class="forgeChartDonutHole"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" class="forgeChartTotal">${escapeHtml(number(total))}</text>`;
  return html;
}
