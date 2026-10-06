import MarkdownIt from 'markdown-it';
import { escapeHtml } from './markup';
import { parseChart, renderChart } from './chart';

export interface MarkdownLabels {
  tableLabel?: string; tableHint?: string; chartData?: string; chartPending?: string; chartInvalid?: string;
}
const defaults = { tableLabel: 'Response table', tableHint: 'Scroll horizontally to see all columns.', chartData: 'View chart data',
  chartPending: 'Preparing chart…', chartInvalid: 'Unable to display this chart. Check the chart data below.' };
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
// Absolute web/mail links only. Images stay as alt text: a response must never trigger remote image requests.
markdown.validateLink = url => /^(https?:\/\/|mailto:)/i.test(url) && !/[\u0000-\u0020]/.test(url);
markdown.renderer.rules.image = (tokens, index) => escapeHtml(tokens[index]?.content ?? '');
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet('target', '_blank'); tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.table_open = (_tokens, _index, _options, env) => {
  const labels = env!.labels as typeof defaults;
  return `<section class="forgeMarkdownTable"><p class="forgeMarkdownTableHint">${escapeHtml(labels.tableHint)}</p><div class="forgeMarkdownTableScroll" tabindex="0" role="region" aria-label="${escapeHtml(labels.tableLabel)}"><table>\n`;
};
markdown.renderer.rules.table_close = () => '</table></div></section>\n';
const codeFence = markdown.renderer.rules.fence!;
markdown.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index]!;
  if (token.info.trim().split(/\s/)[0]?.toLowerCase() !== 'chart') return codeFence(tokens, index, options, env, renderer);
  const labels = env!.labels as typeof defaults;
  const lastLine = (env!.lines as string[])[(token.map?.[1] ?? 0) - 1]?.trim() ?? '';
  const closed = lastLine.length >= token.markup.length && [...lastLine].every(character => character === token.markup[0]);
  if (!closed) return `<div class="forgeChartPending" role="status">${escapeHtml(labels.chartPending)}</div>`;
  try { return renderChart(parseChart(token.content), labels.chartData); }
  catch { return `<div class="forgeChartError">${escapeHtml(labels.chartInvalid)}</div><pre><code>${escapeHtml(token.content)}</code></pre>`; }
};
/** CommonMark + tables/strikethrough, with disabled raw HTML and data-only chart fences. */
export function formatAnswer(text: string, labels: MarkdownLabels = {}): string {
  const resolved = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof MarkdownLabels>) if (typeof labels[key] === 'string') resolved[key] = labels[key]!;
  return `<div class="forgeChatMarkdown">${markdown.render(text, { labels: resolved, lines: text.split(/\r?\n/) })}</div>`;
}
