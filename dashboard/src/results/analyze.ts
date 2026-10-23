import { metric, type RunSummary, type TimelineTable } from './parse';

// 결과 화면에서 쓰는 파생 값. 모두 순수 함수다.

export interface ComparisonRow {
  strategy: string;
  colorIndex: number; // 그룹 안에서 전략의 고정 색 슬롯
  connects: number;
  accepted: number;
  rejected: number;
  violations: number;
  rejectionRate: number;
  weightedRejectionRate: number;
  rejectedCapacity: number;
  rejectedFragmentation: number;
  rejectedAvoidable: number;
  utilizationMean: number;
  utilizationVarianceMean: number;
  serverUtilizationVariance: number;
  peakTotalLoad: number;
  imbalanceMean: number; // 최대/평균 이용률, 부하 × 시간 가중 평균
  imbalanceP99: number;
  cvMean: number;
  jainMean: number;
  jainP05: number;
  hotTimeFraction: number;
  decisionServersMean: number; // 결정당 살펴본 서버 수
  selectMean: number;
  selectP99: number;
  timerResolution: number;
}

export function comparisonRow(summary: RunSummary, colorIndex: number): ComparisonRow {
  return {
    strategy: summary.strategy,
    colorIndex,
    connects: metric(summary, 'connects'),
    accepted: metric(summary, 'accepted'),
    rejected: metric(summary, 'rejected'),
    violations: metric(summary, 'violations'),
    rejectionRate: metric(summary, 'rejection_rate'),
    weightedRejectionRate: metric(summary, 'weighted_rejection_rate'),
    rejectedCapacity: metric(summary, 'rejected_capacity'),
    rejectedFragmentation: metric(summary, 'rejected_fragmentation'),
    rejectedAvoidable: metric(summary, 'rejected_avoidable'),
    utilizationMean: metric(summary, 'utilization_mean'),
    utilizationVarianceMean: metric(summary, 'utilization_variance_mean'),
    serverUtilizationVariance: metric(summary, 'server_utilization_variance'),
    peakTotalLoad: metric(summary, 'peak_total_load'),
    imbalanceMean: metric(summary, 'imbalance_mean'),
    imbalanceP99: metric(summary, 'imbalance_p99'),
    cvMean: metric(summary, 'cv_mean'),
    jainMean: metric(summary, 'jain_mean'),
    jainP05: metric(summary, 'jain_p05'),
    hotTimeFraction: metric(summary, 'hot_time_fraction'),
    decisionServersMean: metric(summary, 'decision_servers_mean'),
    selectMean: metric(summary, 'select_ns_mean'),
    selectP99: metric(summary, 'select_ns_p99'),
    timerResolution: metric(summary, 'timer_resolution_ns'),
  };
}

export type NumericKey = { [K in keyof ComparisonRow]: ComparisonRow[K] extends number ? K : never }[keyof ComparisonRow];

// 열에서 가장 좋은 값. 값이 없거나 모두 같으면 undefined (강조할 것이 없다).
export function bestValue(rows: ComparisonRow[], key: NumericKey, direction: 'min' | 'max'): number | undefined {
  const values = rows.map((r) => r[key]).filter(Number.isFinite);
  if (values.length < 2) return undefined;
  const best = direction === 'min' ? Math.min(...values) : Math.max(...values);
  const worst = direction === 'min' ? Math.max(...values) : Math.min(...values);
  return sameValue(best, worst) ? undefined : best;
}

export function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12 + 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

export interface UtilizationHeatmap {
  starts: number[]; // 열마다 첫 스냅샷 시각
  ends: number[]; // 열마다 마지막 스냅샷 시각
  cells: [number, number, number][]; // [열, 서버, 이용률]
}

// 서버 × 시간 이용률 격자. 스냅샷이 maxColumns보다 많으면 이웃 스냅샷을 묶고,
// 짧은 과부하를 놓치지 않도록 묶음 안의 최댓값을 쓴다.
export function utilizationHeatmap(
  timeline: TimelineTable,
  capacities: Float64Array,
  maxColumns = 240,
): UtilizationHeatmap {
  const servers = Math.min(timeline.loads.length, capacities.length);
  const columns = Math.min(timeline.length, maxColumns);
  const size = Math.ceil(timeline.length / Math.max(columns, 1));
  const heatmap: UtilizationHeatmap = { starts: [], ends: [], cells: [] };
  for (let column = 0; column * size < timeline.length; column++) {
    const first = column * size;
    const last = Math.min(timeline.length, first + size) - 1;
    heatmap.starts.push(timeline.time[first]);
    heatmap.ends.push(timeline.time[last]);
    for (let server = 0; server < servers; server++) {
      let peak = 0;
      for (let i = first; i <= last; i++) peak = Math.max(peak, timeline.loads[server][i]);
      heatmap.cells.push([column, server, peak / capacities[server]]);
    }
  }
  return heatmap;
}

// 처음 보여줄 시간 범위의 끝. 긴 세션 몇 개 때문에 부하가 거의 없는 꼬리가 길면
// 총 사용량이 최댓값의 5% 아래로 내려간 뒤의 꼬리를 뺀다. 꼬리가 짧으면 전체 범위.
export function activeRangeEnd(timeline: TimelineTable, threshold = 0.05): number {
  if (timeline.length === 0) return 0;
  const end = timeline.time[timeline.length - 1];
  const peak = Math.max(...timeline.totalLoad);
  let last = timeline.length - 1;
  while (last > 0 && timeline.totalLoad[last] < peak * threshold) last--;
  const cut = timeline.time[Math.min(timeline.length - 1, last + 1)];
  return cut < end * 0.8 ? cut : end;
}

// 스냅샷을 windows개 안팎으로 묶어 구간마다 (거절 + 위반) / 연결 요청을 계산한다.
// 구간 안에 연결 요청이 없으면 그 구간은 건너뛴다. 누적 연결 수 열이 없는 결과면 undefined.
export function windowedRejectionRate(timeline: TimelineTable, windows = 100): [number, number][] | undefined {
  const connects = timeline.connects;
  if (!connects || timeline.length < 2) return undefined;
  const step = Math.max(1, Math.ceil((timeline.length - 1) / windows));
  const failed = (i: number) => timeline.rejected[i] + timeline.violations[i];
  const points: [number, number][] = [];
  for (let start = 0; start < timeline.length - 1; start += step) {
    const end = Math.min(timeline.length - 1, start + step);
    const requests = connects[end] - connects[start];
    if (requests > 0) points.push([timeline.time[end], (failed(end) - failed(start)) / requests]);
  }
  return points;
}

export function weightClassLabel(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

export function sum(values: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total;
}
