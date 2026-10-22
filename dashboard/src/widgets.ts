import {
  barSeries,
  baseOption,
  categoryAxis,
  mountChart,
  tooltip,
  valueAxis,
  type ChartOption,
  type ChartTheme,
  type MountedChart,
} from './charts';
import { formatInt, formatNumber } from './format';
import type { Histogram } from './histogram';

// 화면들이 함께 쓰는 HTML 조각과 차트 설정.

export function tile(label: string, value: string, detail: string): string {
  return `<div class="tile"><div class="tile-label">${label}</div>
    <div class="tile-value">${value}</div><div class="tile-detail">${detail}</div></div>`;
}

export function panel(key: string, title: string, subtitle: string, chartClass = 'chart'): string {
  return `<section class="panel"><header><h2>${title}</h2><p>${subtitle}</p></header>
    <div class="${chartClass}" data-chart="${key}"></div></section>`;
}

// 한 화면에 올린 차트들. 다시 그릴 때 한꺼번에 정리한다.
export class ChartSet {
  private charts: MountedChart[] = [];

  mount(root: HTMLElement, key: string, group: string | undefined, option: ChartOption): MountedChart {
    const element = root.querySelector<HTMLElement>(`[data-chart="${key}"]`)!;
    const mounted = mountChart(element, group);
    mounted.chart.setOption(option);
    this.charts.push(mounted);
    return mounted;
  }

  dispose() {
    for (const c of this.charts) c.dispose();
    this.charts = [];
  }
}

// 시간축 확대: 휠/드래그로 확대하고, withSlider면 아래에 범위 슬라이더를 둔다.
export function timeZoom(
  theme: ChartTheme,
  formatTime: (ms: number) => string,
  withSlider: boolean,
  range: { startValue?: number; endValue?: number } = {},
) {
  return [
    { type: 'inside', filterMode: 'none', ...range },
    ...(withSlider
      ? [{
          type: 'slider',
          filterMode: 'none',
          ...range,
          height: 20,
          bottom: 8,
          borderColor: theme.grid,
          fillerColor: theme.seriesWash,
          dataBackground: { lineStyle: { color: theme.muted }, areaStyle: { color: theme.grid } },
          textStyle: { color: theme.muted },
          labelFormatter: formatTime,
        }]
      : []),
  ];
}

export function histogramOption(theme: ChartTheme, histogram: Histogram, format: (v: number) => string) {
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
