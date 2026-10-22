import { baseOption, readChartTheme, stepSeries, tooltip, valueAxis, type ChartOption, type ChartTheme } from '../charts';
import { escapeHtml } from '../dom';
import { formatDuration, formatInt, formatNumber, timeFormatter } from '../format';
import { logHistogram, valueHistogram } from '../histogram';
import { ChartSet, histogramOption, panel, tile, timeZoom } from '../widgets';
import { buildTimeline, type Timeline } from './analyze';
import type { EventDataset } from './dataset';

const TIMELINE_GROUP = 'event-timeline';

interface TooltipParam {
  value: [number, number];
  dataIndex: number;
}

// 이벤트 데이터셋 한 개를 요약 타일, 시간축 차트, 분포 차트로 보여준다.
export class EventDatasetView {
  private readonly charts = new ChartSet();
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
    this.charts.dispose();
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
    const mount = (key: string, group: string | undefined, option: ChartOption) =>
      this.charts.mount(this.root, key, group, option);
    const timeCharts = ['arrivals', 'sessions', ...(summary.allWeightsOne ? [] : ['weight'])];
    // 소수의 긴 세션 때문에 전체 범위가 길게 늘어지면 처음에는 이벤트 대부분이 있는 범위만 보여준다.
    const zoomEnd = summary.bulkEnd < summary.endTime * 0.8 ? summary.bulkEnd : summary.endTime;
    for (const key of timeCharts) {
      const isLast = key === timeCharts[timeCharts.length - 1];
      mount(key, TIMELINE_GROUP, timeChartOption(theme, timeline, summary.endTime, zoomEnd, key, isLast));
    }
    mount('durations', undefined, histogramOption(theme, logHistogram(summary.durations), formatDuration));
    mount('weights', undefined, histogramOption(theme, valueHistogram(summary.weights), formatInt));
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
    dataZoom: timeZoom(theme, formatTime, withSlider, { startValue: 0, endValue: zoomEnd }),
    series: [stepSeries(theme, data)],
  };
}
