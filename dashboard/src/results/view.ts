import {
  baseOption,
  categoryAxis,
  readChartTheme,
  tooltip,
  valueAxis,
  type ChartOption,
  type ChartTheme,
} from '../charts';
import { escapeHtml } from '../dom';
import { formatInt, formatNumber, timeFormatter } from '../format';
import { valueHistogram } from '../histogram';
import { HoverTip } from '../hover-tip';
import { errorBanner } from '../page';
import { ChartSet, histogramOption, panel, tile, timeZoom } from '../widgets';
import {
  activeRangeEnd,
  bestValue,
  comparisonRow,
  sameValue,
  sum,
  utilizationHeatmap,
  type ComparisonRow,
  type NumericKey,
} from './analyze';
import { metric, type AssignmentTable, type RunSummary, type ServerTable, type TimelineTable, type ViolationRow } from './parse';
import type { ResultGroup, ResultRun } from './source';

export interface LoadedRun {
  run: ResultRun;
  colorIndex: number;
  summary: RunSummary;
  timeline: TimelineTable;
}

export interface DetailData {
  run: LoadedRun;
  servers: ServerTable;
  assignments: AssignmentTable;
  violations: ViolationRow[];
}

export interface ResultsModel {
  group: ResultGroup;
  runs: LoadedRun[]; // 불러온 전략 전체 (숨긴 전략 포함)
  errors: string[];
  hidden: Set<string>;
  detail?: DetailData;
  detailError?: string;
}

export interface ResultsHandlers {
  toggle(strategy: string): void;
  selectDetail(strategy: string): void;
}

const COMPARE_GROUP = 'results-compare';
const MAX_VIOLATION_ROWS = 100;

const percent = (v: number) => `${formatNumber(v * 100)}%`;
const nanoseconds = (v: number) => `${formatNumber(v)}ns`;

// 분산처럼 아주 작은 값은 지수 표기로
function formatSmall(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v === 0) return '0';
  return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toFixed(4);
}

interface Column {
  label: string;
  key: NumericKey;
  format: (v: number) => string;
  best?: 'min' | 'max';
}

const COLUMNS: Column[] = [
  { label: '수락', key: 'accepted', format: formatInt, best: 'max' },
  { label: '거절', key: 'rejected', format: formatInt, best: 'min' },
  { label: '위반', key: 'violations', format: formatInt, best: 'min' },
  { label: '거절률', key: 'rejectionRate', format: percent, best: 'min' },
  { label: '평균 이용률', key: 'utilizationMean', format: percent },
  { label: '이용률 분산 (시간 평균)', key: 'utilizationVarianceMean', format: formatSmall, best: 'min' },
  { label: '서버별 평균 이용률 분산', key: 'serverUtilizationVariance', format: formatSmall, best: 'min' },
  { label: '선택 시간 평균', key: 'selectMean', format: nanoseconds, best: 'min' },
  { label: '선택 시간 p99', key: 'selectP99', format: nanoseconds, best: 'min' },
];

// 한 데이터셋에 대한 여러 전략의 결과를 비교하고, 고른 전략 하나를 자세히 보여준다.
export class ResultsView {
  private readonly charts = new ChartSet();
  private model?: ResultsModel;
  private tip?: HoverTip;

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: ResultsHandlers,
  ) {}

  render(model: ResultsModel) {
    this.model = model;
    this.charts.dispose();
    this.tip?.dispose(); // 다시 그리면 칩이 바뀌므로 열려 있던 설명도 닫는다
    this.tip = new HoverTip();
    const theme = readChartTheme();
    const visible = model.runs.filter((r) => !model.hidden.has(r.summary.strategy));
    const rows = visible.map((r) => comparisonRow(r.summary, r.colorIndex));
    const first = model.runs[0]?.summary;

    this.root.innerHTML = `
      ${model.errors.length ? errorBanner('일부 전략의 결과를 읽지 못했다.', model.errors.map(escapeHtml)) : ''}
      <section class="section-head">
        <h2>전략 비교</h2>
        ${first ? `<p>${runDescription(first)}</p>` : ''}
      </section>
      <div class="chips" role="group" aria-label="비교할 전략">${model.runs.map((r) => chip(r, model.hidden)).join('')}</div>
      <section class="panel table-panel">${comparisonTable(rows, model.detail?.run.summary.strategy)}</section>
      <div class="columns columns-3">
        ${panel('reject', '거절률', '(거절 + 위반) / 연결 요청', 'chart chart-short')}
        ${panel('balance', '서버 간 이용률 분산', '시간 평균 · 작을수록 고르게 나뉜다', 'chart chart-short')}
        ${panel('select', '서버 선택 시간', 'selectServer() 평균 실행 시간', 'chart chart-short')}
      </div>
      ${panel('variance-trend', '서버 간 이용률 분산 추이', '스냅샷 시각마다 서버 이용률의 분산 · 휠로 확대')}
      ${panel('reject-trend', '누적 거절 추이', '거절 + 위반 누적 수')}
      ${this.detailHtml(model)}
    `;

    const runsByName = new Map(model.runs.map((r) => [r.summary.strategy, r]));
    this.root.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
      const strategy = button.dataset.toggle!;
      button.addEventListener('click', () => this.handlers.toggle(strategy));
      this.tip!.attach(button, strategyTip(runsByName.get(strategy)!.summary));
    });
    this.root.querySelectorAll<HTMLElement>('[data-detail-row]').forEach((row) =>
      row.addEventListener('click', () => this.handlers.selectDetail(row.dataset.detailRow!)),
    );
    this.root.querySelector<HTMLSelectElement>('[data-role="detail"]')?.addEventListener('change', (e) =>
      this.handlers.selectDetail((e.target as HTMLSelectElement).value),
    );

    const mount = (key: string, group: string | undefined, option: ChartOption) =>
      this.charts.mount(this.root, key, group, option);
    mount('reject', undefined, comparisonBarOption(theme, rows, 'rejectionRate', percent));
    mount('balance', undefined, comparisonBarOption(theme, rows, 'utilizationVarianceMean', formatSmall));
    mount('select', undefined, comparisonBarOption(theme, rows, 'selectMean', nanoseconds));

    const endTime = Math.max(0, ...visible.map((r) => metric(r.summary, 'end_time')));
    const formatTime = timeFormatter(endTime);
    const zoomEnd = Math.max(0, ...visible.map((r) => activeRangeEnd(r.timeline)));
    mount('variance-trend', COMPARE_GROUP,
          trendOption(theme, visible, (t, i) => t.utilizationVariance[i], formatSmall, formatTime, zoomEnd, false));
    mount('reject-trend', COMPARE_GROUP,
          trendOption(theme, visible, (t, i) => t.rejected[i] + t.violations[i], formatInt, formatTime, zoomEnd, true));

    if (model.detail) this.mountDetail(theme, model.detail);
  }

  refreshTheme() {
    if (this.model) this.render(this.model);
  }

  dispose() {
    this.charts.dispose();
    this.tip?.dispose();
    this.tip = undefined;
  }

  private detailHtml(model: ResultsModel): string {
    const options = model.runs
      .map((r) => {
        const name = escapeHtml(r.summary.strategy);
        const selected = r.summary.strategy === model.detail?.run.summary.strategy ? ' selected' : '';
        return `<option value="${name}"${selected}>${name}</option>`;
      })
      .join('');
    const head = `<section class="section-head">
        <h2>전략 상세</h2>
        <label class="field inline"><span>전략</span><select data-role="detail">${options}</select></label>
      </section>`;
    if (model.detailError) return head + errorBanner(escapeHtml(model.detailError), []);
    const detail = model.detail;
    if (!detail) return head;

    const s = detail.run.summary;
    const capacity = sum(detail.servers.capacity);
    const serverCount = detail.servers.length;
    const heatmapHeight = Math.min(640, Math.max(200, serverCount * 16 + 90));
    const resolution = metric(s, 'timer_resolution_ns');
    return `${head}
      <section class="tiles">
        ${tile('수락', formatInt(metric(s, 'accepted')), `연결 요청 ${formatInt(metric(s, 'connects'))}건`)}
        ${tile('거절률', percent(metric(s, 'rejection_rate')),
               `거절 ${formatInt(metric(s, 'rejected'))} · 위반 ${formatInt(metric(s, 'violations'))}`)}
        ${tile('평균 이용률', percent(metric(s, 'utilization_mean')), '시간 가중 평균')}
        ${tile('최대 총 사용량', formatInt(metric(s, 'peak_total_load')),
               `총 용량 ${formatInt(capacity)}의 ${percent(metric(s, 'peak_total_load') / capacity)}`)}
        ${tile('선택 시간 평균', nanoseconds(metric(s, 'select_ns_mean')),
               `p99 ${nanoseconds(metric(s, 'select_ns_p99'))} · 최대 ${nanoseconds(metric(s, 'select_ns_max'))}`)}
      </section>
      ${panel('load', '총 사용량', `모든 서버 사용량의 합 · 가로선은 총 용량 ${formatInt(capacity)}`)}
      <section class="panel"><header><h2>서버별 이용률 추이</h2>
        <p>서버 ${formatInt(serverCount)}대 · 칸마다 그 구간의 최대 이용률(사용량/크기)</p></header>
        <div class="chart" data-chart="heatmap" style="height: ${heatmapHeight}px"></div></section>
      <div class="columns">
        ${panel('server-util', '서버별 이용률', '시간 가중 평균과 최댓값')}
        ${panel('select-dist', '서버 선택 시간 분포',
                `쿼리별 실행 시간 · 시계 해상도 ${formatInt(resolution)}ns라 값이 그 배수로 찍힌다`)}
      </div>
      ${violationTable(detail.violations)}
    `;
  }

  private mountDetail(theme: ChartTheme, detail: DetailData) {
    const s = detail.run.summary;
    const formatTime = timeFormatter(metric(s, 'end_time'));
    const zoomEnd = activeRangeEnd(detail.run.timeline);
    const mount = (key: string, option: ChartOption) => this.charts.mount(this.root, key, undefined, option);
    mount('load', totalLoadOption(theme, detail.run.timeline, sum(detail.servers.capacity), formatTime, zoomEnd));
    mount('heatmap', heatmapOption(theme, detail.run.timeline, detail.servers, formatTime, zoomEnd));
    mount('server-util', serverUtilizationOption(theme, detail.servers));
    mount('select-dist', histogramOption(theme, valueHistogram(detail.assignments.selectNs), nanoseconds));
  }
}

function runDescription(s: RunSummary): string {
  return [
    `이벤트 <code>${escapeHtml(s.eventsFile)}</code>`,
    `서버 <code>${escapeHtml(s.servers)}</code> (${formatInt(metric(s, 'server_count'))}대, 총 용량 ${formatInt(metric(s, 'total_capacity'))})`,
    `연결 요청 ${formatInt(metric(s, 'connects'))}건`,
  ].join(' · ');
}

function swatch(colorIndex: number): string {
  return `<span class="swatch" style="background: var(--series-${(colorIndex % 8) + 1})" aria-hidden="true"></span>`;
}

function chip(run: LoadedRun, hidden: Set<string>): string {
  const name = escapeHtml(run.summary.strategy);
  const pressed = !hidden.has(run.summary.strategy);
  return `<button type="button" class="chip" data-toggle="${name}" aria-pressed="${pressed}">
      ${swatch(run.colorIndex)}${name}</button>`;
}

// 칩 설명: 엔진이 summary.csv에 기록한 전략 설명(StrategyInfo::description)과 적용된 파라미터.
function strategyTip(s: RunSummary): string {
  // 설명은 '이름: 방식' 형식이다.
  const colon = s.description.indexOf(': ');
  const title = colon > 0 ? s.description.slice(0, colon) : '';
  const body = colon > 0 ? s.description.slice(colon + 2) : s.description;
  const params = [...s.strategyParams]
    .map(([key, value]) => `<code>${escapeHtml(key)}=${escapeHtml(value)}</code>`)
    .join(' ');
  return `<div class="hover-tip-title">${escapeHtml(s.strategy)}${title ? ` · ${escapeHtml(title)}` : ''}</div>
    <p>${body ? escapeHtml(body) : '설명 없음: 설명을 기록하기 전의 엔진이 만든 결과다. lb_simulator로 다시 실행하면 나타난다.'}</p>
    ${params ? `<p class="hover-tip-params">파라미터 ${params}</p>` : ''}`;
}

function comparisonTable(rows: ComparisonRow[], current: string | undefined): string {
  const best = COLUMNS.map((c) => (c.best ? bestValue(rows, c.key, c.best) : undefined));
  const head = COLUMNS.map((c) => `<th scope="col">${c.label}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = COLUMNS.map((c, i) => {
        const isBest = best[i] !== undefined && sameValue(row[c.key], best[i]!);
        return `<td class="${isBest ? 'best' : ''}">${c.format(row[c.key])}</td>`;
      }).join('');
      const name = escapeHtml(row.strategy);
      const isCurrent = row.strategy === current;
      return `<tr data-detail-row="${name}" class="${isCurrent ? 'current' : ''}" title="클릭하면 아래에 상세를 보여준다">
          <th scope="row">${swatch(row.colorIndex)}${name}</th>${cells}</tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table class="compare">
      <thead><tr><th scope="col">전략</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="table-note">굵은 값이 열에서 가장 좋은 값이다. 행을 누르면 아래에 그 전략의 상세를 보여준다.</p>`;
}

function violationTable(violations: ViolationRow[]): string {
  if (violations.length === 0) {
    return `<p class="status status-good"><span class="status-icon" aria-hidden="true">✓</span>
      위반 없음: 전략이 할당할 수 없는 서버를 고른 적이 없다.</p>`;
  }
  const rows = violations
    .slice(0, MAX_VIOLATION_ROWS)
    .map((v) => `<tr><td>${formatInt(v.sessionId)}</td><td>${formatInt(v.time)}ms</td><td>${formatInt(v.weight)}</td>
        <td>#${v.chosenServer}</td><td>${v.remaining < 0 ? '-' : formatInt(v.remaining)}</td>
        <td>${escapeHtml(v.reason)}</td></tr>`)
    .join('');
  const more = violations.length - MAX_VIOLATION_ROWS;
  return `<section class="panel table-panel"><header><h2>위반 내역</h2>
      <p>${formatInt(violations.length)}건${more > 0 ? ` · 처음 ${MAX_VIOLATION_ROWS}건만 표시` : ''}</p></header>
      <div class="table-scroll"><table class="compare">
        <thead><tr><th>세션</th><th>시각</th><th>가중치</th><th>고른 서버</th><th>남은 용량</th><th>사유</th></tr></thead>
        <tbody>${rows}</tbody></table></div></section>`;
}

// 전략별 가로 막대. 막대 색은 전략의 고정 색, 값은 막대 끝에 쓴다.
function comparisonBarOption(theme: ChartTheme, rows: ComparisonRow[], key: NumericKey, format: (v: number) => string) {
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 64, top: 8, bottom: 8, containLabel: true },
    xAxis: valueAxis(theme, { axisLabel: { show: false }, splitLine: { show: false } }),
    yAxis: categoryAxis(theme, rows.map((r) => r.strategy), {
      inverse: true,
      axisLine: { show: false },
      axisLabel: { color: theme.textSecondary },
    }),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: theme.seriesWash } },
      formatter: (params: { dataIndex: number }[]) => {
        const row = rows[params[0].dataIndex];
        return `<div class="tip-muted">${escapeHtml(row.strategy)}</div><b>${format(row[key])}</b>`;
      },
    }),
    series: [
      {
        type: 'bar',
        barMaxWidth: 18,
        data: rows.map((r) => ({
          value: Number.isFinite(r[key]) ? r[key] : 0,
          itemStyle: { color: theme.categorical[r.colorIndex % 8], borderRadius: [0, 4, 4, 0] },
        })),
        label: { show: true, position: 'right', color: theme.textSecondary, formatter: (p: { value: number }) => format(p.value) },
      },
    ],
  };
}

interface AxisParam {
  marker: string;
  seriesName: string;
  value: [number, number];
}

// 전략별 시간 추이. 전략마다 고정 색의 선 하나.
function trendOption(
  theme: ChartTheme,
  runs: LoadedRun[],
  valueAt: (timeline: TimelineTable, index: number) => number,
  format: (v: number) => string,
  formatTime: (ms: number) => string,
  zoomEnd: number,
  withSlider: boolean,
) {
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 36, bottom: withSlider ? 48 : 8, containLabel: true },
    legend: {
      top: 0,
      type: 'scroll',
      selectedMode: false,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 4,
      textStyle: { color: theme.textSecondary },
    },
    xAxis: valueAxis(theme, {
      min: 'dataMin',
      max: 'dataMax',
      splitLine: { show: false },
      axisLine: { show: true, lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, formatter: formatTime, hideOverlap: true },
    }),
    yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, formatter: format } }),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.muted } },
      formatter: (params: AxisParam[]) =>
        `<div class="tip-muted">${formatTime(params[0].value[0])}</div>` +
        params.map((p) => `${p.marker}${escapeHtml(p.seriesName)} <b>${format(p.value[1])}</b>`).join('<br/>'),
    }),
    dataZoom: timeZoom(theme, formatTime, withSlider, { endValue: zoomEnd }),
    series: runs.map((r) => ({
      type: 'line',
      name: r.summary.strategy,
      showSymbol: false,
      data: Array.from(r.timeline.time, (t, i) => [t, valueAt(r.timeline, i)]),
      lineStyle: { color: theme.categorical[r.colorIndex % 8], width: 2, join: 'round', cap: 'round' },
      itemStyle: { color: theme.categorical[r.colorIndex % 8] },
      emphasis: { focus: 'series' },
    })),
  };
}

function totalLoadOption(
  theme: ChartTheme,
  timeline: TimelineTable,
  capacity: number,
  formatTime: (ms: number) => string,
  zoomEnd: number,
) {
  const peak = Math.max(0, ...timeline.totalLoad);
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 24, bottom: 48, containLabel: true },
    xAxis: valueAxis(theme, {
      min: 'dataMin',
      max: 'dataMax',
      splitLine: { show: false },
      axisLine: { show: true, lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, formatter: formatTime, hideOverlap: true },
    }),
    yAxis: valueAxis(theme, { max: Math.ceil(Math.max(capacity, peak) * 1.05) }),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.muted } },
      formatter: (params: AxisParam[]) => {
        const [t, load] = params[0].value;
        return `<div class="tip-muted">${formatTime(t)}</div><b>사용량 ${formatInt(load)}</b> (${percent(load / capacity)})`;
      },
    }),
    dataZoom: timeZoom(theme, formatTime, true, { endValue: zoomEnd }),
    series: [
      {
        type: 'line',
        showSymbol: false,
        data: Array.from(timeline.time, (t, i) => [t, timeline.totalLoad[i]]),
        lineStyle: { color: theme.series, width: 2, join: 'round', cap: 'round' },
        itemStyle: { color: theme.series },
        areaStyle: { color: theme.seriesWash },
        markLine: {
          symbol: 'none',
          silent: true,
          lineStyle: { color: theme.textSecondary, width: 1, type: 'solid' },
          label: { color: theme.textSecondary, formatter: `총 용량 ${formatInt(capacity)}`, position: 'insideEndTop' },
          data: [{ yAxis: capacity }],
        },
      },
    ],
  };
}

function heatmapOption(
  theme: ChartTheme,
  timeline: TimelineTable,
  servers: ServerTable,
  formatTime: (ms: number) => string,
  zoomEnd: number,
) {
  const heatmap = utilizationHeatmap(timeline, servers.capacity);
  const serverLabels = Array.from({ length: servers.length }, (_, i) => `#${i}`);
  const labels = heatmap.starts.map(formatTime);
  // 범주 축이라 확대 범위는 열 번호로 준다.
  const lastColumn = Math.max(0, heatmap.starts.findLastIndex((t) => t <= zoomEnd));
  const zoom = timeZoom(theme, formatTime, true, { startValue: 0, endValue: lastColumn });
  Object.assign(zoom[1], { labelFormatter: (_: number, label: string) => label });
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 36, bottom: 48, containLabel: true },
    xAxis: categoryAxis(theme, labels, { splitArea: { show: false } }),
    yAxis: categoryAxis(theme, serverLabels, { inverse: true, axisLine: { show: false }, splitArea: { show: false } }),
    visualMap: {
      min: 0,
      max: 1,
      calculable: false,
      orient: 'horizontal',
      right: 16,
      top: 0,
      itemWidth: 10,
      itemHeight: 160,
      text: ['100%', '0%'],
      textStyle: { color: theme.muted },
      inRange: { color: theme.sequential },
    },
    tooltip: tooltip(theme, {
      trigger: 'item',
      formatter: (p: { value: [number, number, number] }) => {
        const [column, server, u] = p.value;
        const range = `${formatTime(heatmap.starts[column])} – ${formatTime(heatmap.ends[column])}`;
        return `<div class="tip-muted">서버 #${server} · ${range}</div><b>최대 이용률 ${percent(u)}</b>`;
      },
    }),
    dataZoom: zoom,
    series: [
      {
        type: 'heatmap',
        data: heatmap.cells,
        emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
      },
    ],
  };
}

function serverUtilizationOption(theme: ChartTheme, servers: ServerTable) {
  const labels = Array.from({ length: servers.length }, (_, i) => `#${i}`);
  const bar = (name: string, values: Float64Array, color: string) => ({
    type: 'bar',
    name,
    data: Array.from(values),
    barMaxWidth: 14,
    barGap: '15%',
    itemStyle: { color, borderRadius: [4, 4, 0, 0] },
  });
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      selectedMode: false,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.textSecondary },
    },
    xAxis: categoryAxis(theme, labels),
    yAxis: valueAxis(theme, { max: 1, axisLabel: { color: theme.muted, formatter: (v: number) => `${Math.round(v * 100)}%` } }),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: theme.seriesWash } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0].dataIndex;
        return `<div class="tip-muted">서버 #${i} · 크기 ${formatInt(servers.capacity[i])}</div>
          평균 <b>${percent(servers.meanUtilization[i])}</b> · 최대 <b>${percent(servers.peakUtilization[i])}</b><br/>
          수락 세션 ${formatInt(servers.acceptedSessions[i])}개`;
      },
    }),
    series: [
      bar('평균 이용률', servers.meanUtilization, theme.categorical[0]),
      bar('최대 이용률', servers.peakUtilization, theme.categorical[1]),
    ],
  };
}
