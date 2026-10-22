import { BarChart, LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

export { echarts };
export type Chart = echarts.ECharts;
export type ChartOption = echarts.EChartsCoreOption;

// 차트 색은 style.css의 CSS 변수에서 읽어 라이트/다크 모드를 한곳에서 바꾼다.
export interface ChartTheme {
  surface: string;
  text: string;
  textSecondary: string;
  muted: string;
  grid: string;
  series: string;
  seriesWash: string;
}

export function readChartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  return {
    surface: v('--surface-1'),
    text: v('--text-primary'),
    textSecondary: v('--text-secondary'),
    muted: v('--text-muted'),
    grid: v('--grid'),
    series: v('--series-1'),
    seriesWash: v('--series-1-wash'),
  };
}

const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });

export function valueAxis(theme: ChartTheme, extra: object = {}) {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, formatter: (v: number) => compact.format(v) },
    splitLine: { lineStyle: { color: theme.grid, width: 1, type: 'solid' } },
    ...extra,
  };
}

export function categoryAxis(theme: ChartTheme, labels: string[], extra: object = {}) {
  return {
    type: 'category',
    data: labels,
    axisLine: { lineStyle: { color: theme.grid } },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, hideOverlap: true },
    ...extra,
  };
}

export function tooltip(theme: ChartTheme, extra: object = {}) {
  return {
    confine: true, // 좁은 화면에서 툴팁이 페이지 밖으로 나가 가로 스크롤을 만들지 않게
    backgroundColor: theme.surface,
    borderColor: theme.grid,
    textStyle: { color: theme.text, fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 16px rgb(0 0 0 / 0.12); border-radius: 8px;',
    ...extra,
  };
}

export function baseOption(theme: ChartTheme): ChartOption {
  return {
    animation: false,
    textStyle: { fontFamily: 'inherit', color: theme.textSecondary },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
  };
}

// 막대: 24px 이하, 끝만 4px 둥글게, 인접 막대 사이 2px 표면 간격
export function barSeries(theme: ChartTheme, data: number[]) {
  return {
    type: 'bar',
    data,
    barMaxWidth: 24,
    barCategoryGap: 2,
    itemStyle: { color: theme.series, borderRadius: [4, 4, 0, 0] },
    emphasis: { itemStyle: { color: theme.series, opacity: 0.8 } },
  };
}

// 시간축 계단선: 2px 선 + 10% 면
export function stepSeries(theme: ChartTheme, data: [number, number][]) {
  return {
    type: 'line',
    data,
    step: 'end',
    showSymbol: false,
    sampling: 'lttb',
    lineStyle: { color: theme.series, width: 2, join: 'round', cap: 'round' },
    itemStyle: { color: theme.series },
    areaStyle: { color: theme.seriesWash },
  };
}

export interface MountedChart {
  chart: Chart;
  dispose(): void;
}

// 요소 크기가 바뀌면 차트도 맞춘다. 같은 group의 차트는 확대 범위와 툴팁이 함께 움직인다.
export function mountChart(element: HTMLElement, group?: string): MountedChart {
  const chart = echarts.init(element, undefined, { renderer: 'canvas' });
  if (group) {
    chart.group = group;
    echarts.connect(group);
  }
  const observer = new ResizeObserver(() => chart.resize());
  observer.observe(element);
  return {
    chart,
    dispose() {
      observer.disconnect();
      chart.dispose();
    },
  };
}
