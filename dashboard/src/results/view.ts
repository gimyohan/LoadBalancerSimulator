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
  weightClassLabel,
  windowedRejectionRate,
  type ComparisonRow,
  type NumericKey,
} from './analyze';
import {
  metric,
  type AssignmentTable,
  type RunSummary,
  type ServerTable,
  type TimelineTable,
  type ViolationRow,
  type WeightClassRow,
} from './parse';
import type { ResultGroup, ResultRun } from './source';

export interface LoadedRun {
  run: ResultRun;
  colorIndex: number;
  summary: RunSummary;
  timeline: TimelineTable;
  weightClasses?: WeightClassRow[]; // 가중치 구간 지표를 쓰기 전의 결과면 없다
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

const percent = (v: number) => (Number.isFinite(v) ? `${formatNumber(v * 100)}%` : '-');
const nanoseconds = (v: number) => (Number.isFinite(v) ? `${formatNumber(v)}ns` : '-');
const count = (v: number) => (Number.isFinite(v) ? formatInt(v) : '-');
const ratio = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '-');
const servers = (v: number) => (Number.isFinite(v) ? `${formatNumber(v)}대` : '-');

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
  title?: string; // 머리글에 마우스를 올리면 보이는 정의
}

// 비교 표의 열 묶음. 굵은 값은 각 열에서 가장 좋은 값이다.
const COLUMN_GROUPS: { label: string; columns: Column[] }[] = [
  {
    label: '처리',
    columns: [
      { label: '수락', key: 'accepted', format: count, best: 'max' },
      { label: '거절률', key: 'rejectionRate', format: percent, best: 'min', title: '(거절 + 위반) / 연결 요청' },
      {
        label: '가중치 거절률',
        key: 'weightedRejectionRate',
        format: percent,
        best: 'min',
        title: '거절된 가중치 / 요청된 가중치. 요청 수 거절률보다 크면 큰 세션이 더 자주 밀려난다',
      },
    ],
  },
  {
    label: '거절 원인',
    columns: [
      { label: '용량 부족', key: 'rejectedCapacity', format: count, title: '전체 남은 용량이 가중치보다 작았다' },
      {
        label: '단편화',
        key: 'rejectedFragmentation',
        format: count,
        best: 'min',
        title: '전체 남은 용량은 충분했지만 들어갈 서버가 없었다',
      },
      {
        label: '회피 가능',
        key: 'rejectedAvoidable',
        format: count,
        best: 'min',
        title: '들어갈 서버가 있었는데 전략이 거절했다',
      },
      { label: '위반', key: 'violations', format: count, best: 'min', title: '전략이 할당할 수 없는 서버를 골랐다' },
    ],
  },
  {
    label: '균형 (부하 가중)',
    columns: [
      { label: '평균 이용률', key: 'utilizationMean', format: percent, title: '시간 가중 평균' },
      {
        label: '최대/평균',
        key: 'imbalanceMean',
        format: ratio,
        best: 'min',
        title: '가장 바쁜 서버의 이용률 / 평균 이용률. 1이 완전 균형',
      },
      { label: '최대/평균 p99', key: 'imbalanceP99', format: ratio, best: 'min', title: '부하가 실린 시간 중 상위 1%' },
      { label: '변동계수', key: 'cvMean', format: ratio, best: 'min', title: '이용률 표준편차 / 평균. 0이 완전 균형' },
      { label: 'Jain', key: 'jainMean', format: ratio, best: 'max', title: 'Jain 공정성 지수. 1이 완전 균형' },
    ],
  },
  {
    label: '결정 비용',
    columns: [
      {
        label: '조회 서버 수',
        key: 'decisionServersMean',
        format: servers,
        best: 'min',
        title: '결정 하나에서 살펴본 서버 수의 평균. 시계 해상도와 무관하다',
      },
      { label: '선택 시간', key: 'selectMean', format: nanoseconds, best: 'min', title: 'selectServer() 평균 실행 시간' },
    ],
  },
];
const COLUMNS = COLUMN_GROUPS.flatMap((g) => g.columns);

// 거절 원인 막대의 묶음. 피할 수 없는 것에서 전략 탓인 것 순서다.
const REJECT_PARTS: { label: string; key: NumericKey }[] = [
  { label: '용량 부족', key: 'rejectedCapacity' },
  { label: '단편화', key: 'rejectedFragmentation' },
  { label: '회피 가능', key: 'rejectedAvoidable' },
  { label: '위반', key: 'violations' },
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
    const outdated = model.runs.some((r) => !r.summary.metrics.has('imbalance_mean'));
    const hasImbalance = visible.some((r) => r.timeline.imbalance);
    const rejectWindows = visible.every((r) => r.timeline.connects);

    this.root.innerHTML = `
      ${model.errors.length ? errorBanner('일부 전략의 결과를 읽지 못했다.', model.errors.map(escapeHtml)) : ''}
      <section class="section-head">
        <h2>전략 비교</h2>
        ${first ? `<p>${runDescription(first)}</p>` : ''}
      </section>
      <div class="chips" role="group" aria-label="비교할 전략">${model.runs.map((r) => chip(r, model.hidden)).join('')}</div>
      ${outdated ? '<p class="note">일부 결과는 새 지표를 기록하기 전의 엔진으로 만들었다. 비어 있는 값은 <code>lb_simulator</code>로 다시 실행하면 채워진다.</p>' : ''}
      <section class="panel table-panel">${comparisonTable(rows, model.detail?.run.summary.strategy)}</section>
      <div class="columns columns-3">
        ${panel('reasons', '거절 원인', '연결 요청 대비 비율 · 원인별', 'chart chart-short')}
        ${panel('balance', '최대/평균 이용률', '부하 가중 평균 · 1이 완전 균형', 'chart chart-short')}
        ${panel('cost', '결정 비용', '결정 하나에서 살펴본 서버 수의 평균', 'chart chart-short')}
      </div>
      ${hasImbalance
        ? panel('balance-trend', '최대/평균 이용률 추이',
                '스냅샷 시각마다 가장 바쁜 서버 / 평균 · 세션이 몇 개뿐인 순간의 큰 값은 위를 잘라 그린다 · 휠로 확대')
        : panel('balance-trend', '서버 간 이용률 분산 추이', '스냅샷 시각마다 서버 이용률의 분산 · 휠로 확대')}
      ${panel('reject-trend', rejectWindows ? '구간별 거절률' : '누적 거절 추이',
              rejectWindows ? '구간마다 (거절 + 위반) / 연결 요청' : '거절 + 위반 누적 수')}
      ${weightClassPanel(visible)}
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
    mount('reasons', undefined, rejectReasonOption(theme, rows));
    mount('balance', undefined, comparisonBarOption(theme, rows, 'imbalanceMean', ratio, (row) =>
      `p99 ${ratio(row.imbalanceP99)} · 변동계수 ${ratio(row.cvMean)} · Jain ${ratio(row.jainMean)}`));
    mount('cost', undefined, comparisonBarOption(theme, rows, 'decisionServersMean', servers, (row) =>
      `선택 시간 평균 ${nanoseconds(row.selectMean)}`));

    const endTime = Math.max(0, ...visible.map((r) => metric(r.summary, 'end_time')));
    const formatTime = timeFormatter(endTime);
    const zoomEnd = Math.max(0, ...visible.map((r) => activeRangeEnd(r.timeline)));
    const series = (valueAt: (t: TimelineTable, i: number) => number) => (t: TimelineTable) =>
      Array.from(t.time, (time, i): [number, number] => [time, valueAt(t, i)]);
    mount('balance-trend', COMPARE_GROUP, hasImbalance
      ? trendOption(theme, visible, series((t, i) => t.imbalance?.[i] ?? NaN), ratio, formatTime, zoomEnd, false,
                    imbalanceAxisMax(visible))
      : trendOption(theme, visible, series((t, i) => t.utilizationVariance[i]), formatSmall, formatTime, zoomEnd, false));
    mount('reject-trend', COMPARE_GROUP, rejectWindows
      ? trendOption(theme, visible, (t) => windowedRejectionRate(t) ?? [], percent, formatTime, zoomEnd, true)
      : trendOption(theme, visible, series((t, i) => t.rejected[i] + t.violations[i]), formatInt, formatTime, zoomEnd, true));
    if (this.root.querySelector('[data-chart="weight-classes"]')) {
      mount('weight-classes', undefined, weightClassOption(theme, visible));
    }

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
    const hot = metric(s, 'hot_threshold');
    return `${head}
      <section class="tiles">
        ${tile('수락', formatInt(metric(s, 'accepted')), `연결 요청 ${formatInt(metric(s, 'connects'))}건`)}
        ${tile('거절률', percent(metric(s, 'rejection_rate')),
               `가중치 기준 ${percent(metric(s, 'weighted_rejection_rate'))} · 위반 ${count(metric(s, 'violations'))}`)}
        ${tile('거절 원인', `${count(metric(s, 'rejected_fragmentation'))} · ${count(metric(s, 'rejected_avoidable'))}`,
               `단편화 · 회피 가능 (용량 부족 ${count(metric(s, 'rejected_capacity'))})`)}
        ${tile('최대/평균 이용률', ratio(metric(s, 'imbalance_mean')),
               `p99 ${ratio(metric(s, 'imbalance_p99'))} · Jain ${ratio(metric(s, 'jain_mean'))}`)}
        ${tile('포화 시간', percent(metric(s, 'hot_time_fraction')),
               `이용률 ${percent(hot)} 이상 · 꽉 참 ${percent(metric(s, 'full_time_fraction'))}`)}
        ${tile('최대 총 사용량', formatInt(metric(s, 'peak_total_load')),
               `총 용량 ${formatInt(capacity)}의 ${percent(metric(s, 'peak_total_load') / capacity)}`)}
        ${tile('결정 비용', servers(metric(s, 'decision_servers_mean')),
               `조회 서버 수 평균 · 선택 시간 ${nanoseconds(metric(s, 'select_ns_mean'))}`)}
      </section>
      ${panel('load', '총 사용량', `모든 서버 사용량의 합 · 가로선은 총 용량 ${formatInt(capacity)}`)}
      <section class="panel"><header><h2>서버별 이용률 추이</h2>
        <p>서버 ${formatInt(serverCount)}대 · 칸마다 그 구간의 최대 이용률(사용량/크기)</p></header>
        <div class="chart" data-chart="heatmap" style="height: ${heatmapHeight}px"></div></section>
      ${panel('server-util', '서버별 이용률', '시간 가중 평균과 최댓값')}
      ${serverTable(detail.servers, hot)}
      <div class="columns">
        ${detail.assignments.serversInspected
          ? panel('decision-dist', '결정당 조회 서버 수', '결정 하나에서 살펴본 서로 다른 서버 수')
          : ''}
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
    if (detail.assignments.serversInspected) {
      mount('decision-dist', histogramOption(theme, valueHistogram(detail.assignments.serversInspected), servers));
    }
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
  const groupHead = COLUMN_GROUPS.map(
    (g) => `<th scope="colgroup" colspan="${g.columns.length}" class="group">${g.label}</th>`,
  ).join('');
  const head = COLUMNS.map((c) => `<th scope="col"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>${c.label}</th>`).join('');
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
      <thead><tr><th rowspan="2" scope="col">전략</th>${groupHead}</tr><tr>${head}</tr></thead>
      <tbody>${body}</tbody></table></div>
    <p class="table-note">굵은 값이 열에서 가장 좋은 값이다. 머리글에 마우스를 올리면 정의가, 행을 누르면 아래에 그 전략의 상세가 나온다.
      균형 지수는 그 순간의 총 사용량 × 지속 시간으로 가중해 한산한 구간의 영향을 줄였다.</p>`;
}

// 서버별 포화도. 이전 엔진의 결과에는 없는 열은 '-'로 둔다.
function serverTable(table: ServerTable, hotThreshold: number): string {
  const cell = (values: Float64Array | undefined, i: number, format: (v: number) => string) =>
    `<td>${values ? format(values[i]) : '-'}</td>`;
  const rows = Array.from({ length: table.length }, (_, i) => {
    const share = table.loadShare && table.capacityShare ? table.loadShare[i] / table.capacityShare[i] : NaN;
    return `<tr><th scope="row">#${i}</th><td>${formatInt(table.capacity[i])}</td>
        <td>${formatInt(table.acceptedSessions[i])}</td>${cell(table.peakSessions, i, count)}
        <td>${percent(table.meanUtilization[i])}</td><td>${percent(table.peakUtilization[i])}</td>
        ${cell(table.hotTimeFraction, i, percent)}${cell(table.fullTimeFraction, i, percent)}
        <td>${ratio(share)}</td></tr>`;
  }).join('');
  const hot = Number.isFinite(hotThreshold) ? percent(hotThreshold) : '90%';
  return `<section class="panel table-panel"><header><h2>서버별 포화도</h2>
      <p>시간 비율은 첫 이벤트부터 마지막 이벤트까지 기준 · 몫 비율이 1보다 크면 크기에 비해 많은 부하를 맡았다</p></header>
      <div class="table-scroll table-tall"><table class="compare">
        <thead><tr><th scope="col">서버</th><th scope="col">크기</th><th scope="col">수락 세션</th>
          <th scope="col">최대 동시 세션</th><th scope="col">평균 이용률</th><th scope="col">최대 이용률</th>
          <th scope="col">${hot} 이상 시간</th><th scope="col">꽉 찬 시간</th>
          <th scope="col" title="이 서버가 맡은 사용량-시간 비율 / 이 서버 크기 비율">사용량 몫 / 용량 몫</th></tr></thead>
        <tbody>${rows}</tbody></table></div></section>`;
}

// 최대/평균 추이의 세로축 상한. 세션이 몇 개뿐인 순간에는 이 값이 서버 수만큼 커져 축을 차지하므로,
// 부하 가중 p99의 1.2배에서 자른다.
function imbalanceAxisMax(runs: LoadedRun[]): number | undefined {
  const p99 = runs.map((r) => metric(r.summary, 'imbalance_p99')).filter(Number.isFinite);
  return p99.length ? Math.ceil(Math.max(...p99) * 1.2 * 10) / 10 : undefined;
}

function weightClassPanel(runs: LoadedRun[]): string {
  const withClasses = runs.filter((r) => r.weightClasses);
  if (withClasses.length === 0) return '';
  const classes = new Set(withClasses.flatMap((r) => r.weightClasses!.map((c) => c.weightMin)));
  if (classes.size < 2) {
    return '<p class="note">모든 세션의 가중치가 한 구간에 있어 가중치 구간별 거절률은 생략했다.</p>';
  }
  return panel('weight-classes', '가중치 구간별 거절률', '구간마다 (거절 + 위반) / 요청 · 큰 세션이 더 자주 밀려나는지 본다');
}

// 가중치 구간 × 전략 묶음 막대. 막대 색은 전략의 고정 색이다.
function weightClassOption(theme: ChartTheme, runs: LoadedRun[]) {
  const withClasses = runs.filter((r) => r.weightClasses);
  const bounds = new Map<number, number>();
  for (const r of withClasses) for (const c of r.weightClasses!) bounds.set(c.weightMin, c.weightMax);
  const mins = [...bounds.keys()].sort((a, b) => a - b);
  const labels = mins.map((m) => weightClassLabel(m, bounds.get(m)!));
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, type: 'scroll', selectedMode: false, icon: 'roundRect', itemWidth: 10, itemHeight: 10,
              textStyle: { color: theme.textSecondary } },
    xAxis: categoryAxis(theme, labels, { name: '가중치', nameLocation: 'end', nameTextStyle: { color: theme.muted } }),
    yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, formatter: percent } }),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: theme.seriesWash } },
      formatter: (params: { marker: string; seriesName: string; dataIndex: number; value: number }[]) => {
        const min = mins[params[0].dataIndex];
        const lines = params.map((p) => {
          const c = withClasses.find((r) => r.summary.strategy === p.seriesName)?.weightClasses?.find((w) => w.weightMin === min);
          const detail = c ? ` (${formatInt(c.rejected + c.violations)} / ${formatInt(c.requests)})` : '';
          return `${p.marker}${escapeHtml(p.seriesName)} <b>${percent(p.value)}</b>${detail}`;
        });
        return `<div class="tip-muted">가중치 ${labels[params[0].dataIndex]}</div>${lines.join('<br/>')}`;
      },
    }),
    series: withClasses.map((r) => ({
      type: 'bar',
      name: r.summary.strategy,
      barMaxWidth: 14,
      barGap: '15%',
      itemStyle: { color: theme.categorical[r.colorIndex % 8], borderRadius: [4, 4, 0, 0] },
      data: mins.map((m) => r.weightClasses!.find((c) => c.weightMin === m)?.rejectionRate ?? 0),
    })),
  };
}

// 전략별 거절 원인 누적 막대. 원인은 피할 수 없는 것 → 전략 탓 순서라 한 색상의 밝기 단계로 칠한다.
function rejectReasonOption(theme: ChartTheme, rows: ComparisonRow[]) {
  const rate = (row: ComparisonRow, key: NumericKey) =>
    row.connects > 0 && Number.isFinite(row[key]) ? row[key] / row.connects : 0;
  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, selectedMode: false, icon: 'roundRect', itemWidth: 10, itemHeight: 10,
              textStyle: { color: theme.textSecondary } },
    xAxis: valueAxis(theme, { axisLabel: { color: theme.muted, formatter: percent } }),
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
        const lines = REJECT_PARTS.map((part) => `${part.label} ${count(row[part.key])}건`).join(' · ');
        return `<div class="tip-muted">${escapeHtml(row.strategy)}</div><b>거절률 ${percent(row.rejectionRate)}</b><br/>${lines}`;
      },
    }),
    series: REJECT_PARTS.map((part, i) => ({
      type: 'bar',
      name: part.label,
      stack: 'reasons',
      barMaxWidth: 18,
      itemStyle: { color: theme.sequential[i + 1], borderColor: theme.surface, borderWidth: 1 },
      data: rows.map((row) => rate(row, part.key)),
    })),
  };
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
function comparisonBarOption(
  theme: ChartTheme,
  rows: ComparisonRow[],
  key: NumericKey,
  format: (v: number) => string,
  detail?: (row: ComparisonRow) => string, // 툴팁에 덧붙일 줄
) {
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
        const extra = detail ? `<div class="tip-muted">${detail(row)}</div>` : '';
        return `<div class="tip-muted">${escapeHtml(row.strategy)}</div><b>${format(row[key])}</b>${extra}`;
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
  dataOf: (timeline: TimelineTable) => [number, number][],
  format: (v: number) => string,
  formatTime: (ms: number) => string,
  zoomEnd: number,
  withSlider: boolean,
  yMax?: number, // 이 값 위는 잘라 그린다
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
    yAxis: valueAxis(theme, { max: yMax, axisLabel: { color: theme.muted, formatter: format } }),
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
      data: dataOf(r.timeline),
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
