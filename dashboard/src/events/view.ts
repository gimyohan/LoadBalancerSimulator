import {
  barSeries,
  baseOption,
  categoryAxis,
  mountChart,
  readChartTheme,
  stepSeries,
  tooltip,
  valueAxis,
  type ChartOption,
  type ChartTheme,
  type MountedChart,
} from '../charts';
import { escapeHtml } from '../dom';
import { formatDuration, formatInt, formatNumber, timeFormatter } from '../format';
import { buildTimeline, durationHistogram, weightHistogram, type Histogram, type Timeline } from './analyze';
import type { EventDataset } from './dataset';

const TIMELINE_GROUP = 'event-timeline';

interface TooltipParam {
  value: [number, number];
  dataIndex: number;
}

// 이벤트 데이터셋 한 개를 요약 타일, 시간축 차트, 분포 차트로 보여준다.
export class EventDatasetView {
  private charts: MountedChart[] = [];
  private dataset?: EventDataset;
  private bins = 300;

  constructor(private readonly root: HTMLElement) {}

  show(dataset: EventDataset) {
    this.dataset = dataset;
    this.render();
  }

  setBins(bins: number) {
    this.bins = bins;
    if (this.dataset) this.render();
  }

  refreshTheme() {
    if (this.dataset) this.render();
  }

  dispose() {
    for (const c of this.charts) c.dispose();
    this.charts = [];
  }

  private render() {
    const dataset = this.dataset!;
    const { summary } = dataset;
    const timeline = buildTimeline(dataset.table, this.bins);
    const formatTime = timeFormatter(summary.endTime);
    this.dispose();

    this.root.innerHTML = `
      ${validationBanner(dataset)}
      <section class="tiles">
        ${tile('세션', formatInt(summary.sessions), `이벤트 ${formatInt(summary.events)}개`)}
        ${tile('데이터 기간', formatDuration(summary.endTime), `마지막 연결 ${formatTime(summary.lastArrival)}`)}
        ${tile('지속 시간 중앙값', formatDuration(summary.durationMedian),
               `평균 ${formatDuration(summary.durationMean)} · p95 ${formatDuration(summary.durationP95)}`)}
        ${tile('평균 가중치', formatNumber(summary.weightMean), `최대 ${formatInt(summary.weightMax)}`)}
        ${tile('최대 동시 세션', formatInt(summary.peakSessions.value), `${formatTime(summary.peakSessions.at)} 시점`)}
        ${tile('최대 총 가중치', formatInt(summary.peakWeight.value), `${formatTime(summary.peakWeight.at)} 시점`)}
      </section>
      ${panel('arrivals', '시간에 따른 연결 도착량',
              `구간 폭 ${formatDuration(timeline.binWidth)} · 구간마다 새로 연결된 세션 수 · 휠로 확대, 아래 슬라이더로 범위 이동`)}
      ${panel('sessions', '동시 세션 수', '구간 안의 최댓값')}
      ${summary.allWeightsOne
        ? `<p class="note">모든 가중치가 1이라 총 가중치는 동시 세션 수와 같다.</p>`
        : panel('weight', '총 가중치', '구간 안의 최댓값. 서버 크기 합과 비교할 값')}
      <div class="columns">
        ${panel('durations', '세션 지속 시간 분포', `로그 간격 구간 · 완료된 세션 ${formatInt(summary.durations.length)}개`)}
        ${panel('weights', '가중치 분포', '세션 수')}
      </div>
    `;

    const theme = readChartTheme();
    const timeCharts = ['arrivals', 'sessions', ...(summary.allWeightsOne ? [] : ['weight'])];
    // 소수의 긴 세션 때문에 전체 범위가 길게 늘어지면 처음에는 이벤트 대부분이 있는 범위만 보여준다.
    const zoomEnd = summary.bulkEnd < summary.endTime * 0.8 ? summary.bulkEnd : summary.endTime;
    for (const key of timeCharts) {
      const isLast = key === timeCharts[timeCharts.length - 1];
      this.mount(key, TIMELINE_GROUP, timeChartOption(theme, timeline, summary.endTime, zoomEnd, key, isLast));
    }
    this.mount('durations', undefined, histogramOption(theme, durationHistogram(summary.durations), formatDuration));
    this.mount('weights', undefined, histogramOption(theme, weightHistogram(summary.weights), formatInt));
  }

  private mount(key: string, group: string | undefined, option: ChartOption) {
    const element = this.root.querySelector<HTMLElement>(`[data-chart="${key}"]`)!;
    const mounted = mountChart(element, group);
    mounted.chart.setOption(option);
    this.charts.push(mounted);
  }
}

function validationBanner({ validation }: EventDataset): string {
  if (validation.errorCount === 0) {
    return `<p class="status status-good"><span class="status-icon" aria-hidden="true">✓</span>
      데이터셋 제약 조건 충족 (세션당 연결/해제 한 쌍, 해제가 연결보다 뒤, 모든 시각이 서로 다름)</p>`;
  }
  const items = validation.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
  const more = validation.errorCount - validation.messages.length;
  return `<div class="status status-critical" role="alert">
      <p><span class="status-icon" aria-hidden="true">!</span>
        제약 조건 위반 ${formatInt(validation.errorCount)}건. 위반한 행은 집계에서 건너뛴다.</p>
      <ul>${items}${more > 0 ? `<li>외 ${formatInt(more)}건</li>` : ''}</ul>
    </div>`;
}

function tile(label: string, value: string, detail: string): string {
  return `<div class="tile"><div class="tile-label">${label}</div>
    <div class="tile-value">${value}</div><div class="tile-detail">${detail}</div></div>`;
}

function panel(key: string, title: string, subtitle: string): string {
  return `<section class="panel"><header><h2>${title}</h2><p>${subtitle}</p></header>
    <div class="chart" data-chart="${key}"></div></section>`;
}

const TIME_SERIES = {
  arrivals: { field: 'arrivals', label: '연결' },
  sessions: { field: 'maxSessions', label: '동시 세션' },
  weight: { field: 'maxWeight', label: '총 가중치' },
} as const;

function timeChartOption(
  theme: ChartTheme,
  timeline: Timeline,
  endTime: number,
  zoomEnd: number,
  key: string,
  withSlider: boolean,
) {
  const { field, label } = TIME_SERIES[key as keyof typeof TIME_SERIES];
  const values = timeline[field];
  const formatTime = timeFormatter(endTime);
  // 계단선이 마지막 구간까지 그려지도록 끝점을 하나 더 둔다.
  const data: [number, number][] = Array.from(timeline.starts, (t, i) => [t, values[i]]);
  data.push([timeline.starts[values.length - 1] + timeline.binWidth, values[values.length - 1]]);

  return {
    ...baseOption(theme),
    grid: { left: 8, right: 16, top: 16, bottom: withSlider ? 48 : 8, containLabel: true },
    xAxis: valueAxis(theme, {
      min: 0,
      max: Math.max(endTime, 1),
      splitLine: { show: false },
      axisLine: { show: true, lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.muted, formatter: formatTime, hideOverlap: true },
    }),
    yAxis: valueAxis(theme),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: theme.muted } },
      formatter: (params: TooltipParam[]) => {
        const p = params[0];
        const index = Math.min(p.dataIndex, values.length - 1);
        const start = timeline.starts[index];
        const range = `${formatTime(start)} – ${formatTime(start + timeline.binWidth)}`;
        const value = values[index];
        const rate = key === 'arrivals' ? ` (${formatNumber(value / (timeline.binWidth / 1000))}/초)` : '';
        return `<div class="tip-muted">${range}</div><b>${label} ${formatInt(value)}</b>${rate}`;
      },
    }),
    dataZoom: [
      { type: 'inside', filterMode: 'none', startValue: 0, endValue: zoomEnd },
      ...(withSlider
        ? [{
            type: 'slider',
            filterMode: 'none',
            startValue: 0,
            endValue: zoomEnd,
            height: 20,
            bottom: 8,
            borderColor: theme.grid,
            fillerColor: theme.seriesWash,
            dataBackground: { lineStyle: { color: theme.muted }, areaStyle: { color: theme.grid } },
            textStyle: { color: theme.muted },
            labelFormatter: formatTime,
          }]
        : []),
    ],
    series: [stepSeries(theme, data)],
  };
}

function histogramOption(theme: ChartTheme, histogram: Histogram, format: (v: number) => string) {
  const total = histogram.counts.reduce((acc, c) => acc + c, 0);
  const rangeLabel = (i: number) =>
    histogram.discrete || histogram.lower[i] === histogram.upper[i]
      ? format(histogram.lower[i])
      : `${format(histogram.lower[i])} – ${format(histogram.upper[i])}`;
  return {
    ...baseOption(theme),
    xAxis: categoryAxis(theme, histogram.lower.map((v) => format(v))),
    yAxis: valueAxis(theme),
    tooltip: tooltip(theme, {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: theme.seriesWash } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0].dataIndex;
        const count = histogram.counts[i];
        const share = total ? formatNumber((count / total) * 100) : '0';
        return `<div class="tip-muted">${rangeLabel(i)}</div><b>${formatInt(count)}개</b> (${share}%)`;
      },
    }),
    series: [barSeries(theme, histogram.counts)],
  };
}
