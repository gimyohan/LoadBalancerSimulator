import type { EventTable } from './parse';

// 이벤트 데이터셋의 요약 통계와 차트용 집계. 모든 함수는 시각 순으로 정렬된 표를 받는다.
// 연결 없이 들어온 해제처럼 제약을 어긴 행은 건너뛰어, 잘못된 데이터도 최대한 보여준다.

export interface Peak {
  value: number;
  at: number; // ms
}

export interface EventSummary {
  sessions: number;
  events: number;
  endTime: number; // 마지막 이벤트 시각(ms)
  lastArrival: number; // 마지막 연결 시각(ms)
  bulkEnd: number; // 이벤트의 99%가 끝나는 시각(ms). 긴 꼬리를 빼고 볼 범위

  durationMean: number; // ms
  durationMedian: number;
  durationP95: number;
  durationMax: number;
  weightMean: number;
  weightMax: number;
  allWeightsOne: boolean;
  peakSessions: Peak;
  peakWeight: Peak;
  durations: Float64Array; // 완료된 세션별 지속 시간(ms)
  weights: Float64Array; // 세션별 가중치
}

export interface Timeline {
  binWidth: number; // ms
  starts: Float64Array; // 구간 시작 시각(ms)
  arrivals: Float64Array; // 구간 안의 연결 수
  maxSessions: Float64Array; // 구간 안의 최대 동시 세션 수
  maxWeight: Float64Array; // 구간 안의 최대 총 가중치
}

export interface Histogram {
  lower: number[];
  upper: number[]; // discrete면 lower와 같다
  counts: number[];
  discrete: boolean;
}

function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function summarizeEvents(table: EventTable): EventSummary {
  const open = new Map<number, number>(); // 세션 ID → 연결 시각
  const durations: number[] = [];
  const weights: number[] = [];
  let concurrent = 0;
  let load = 0;
  let lastArrival = 0;
  const peakSessions: Peak = { value: 0, at: 0 };
  const peakWeight: Peak = { value: 0, at: 0 };

  for (let i = 0; i < table.length; i++) {
    const id = table.sessionId[i];
    const ts = table.timestamp[i];
    const w = table.weight[i];
    if (table.connect[i]) {
      if (open.has(id)) continue;
      open.set(id, ts);
      weights.push(w);
      lastArrival = ts;
      concurrent++;
      load += w;
      if (concurrent > peakSessions.value) Object.assign(peakSessions, { value: concurrent, at: ts });
      if (load > peakWeight.value) Object.assign(peakWeight, { value: load, at: ts });
    } else {
      const connectedAt = open.get(id);
      if (connectedAt === undefined) continue;
      open.delete(id);
      durations.push(ts - connectedAt);
      concurrent--;
      load -= w;
    }
  }

  const sortedDurations = Float64Array.from(durations).sort();
  const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);
  return {
    sessions: weights.length,
    events: table.length,
    endTime: table.length ? table.timestamp[table.length - 1] : 0,
    lastArrival,
    bulkEnd: table.length ? table.timestamp[Math.floor(0.99 * (table.length - 1))] : 0,
    durationMean: durations.length ? sum(durations) / durations.length : 0,
    durationMedian: quantile(sortedDurations, 0.5),
    durationP95: quantile(sortedDurations, 0.95),
    durationMax: sortedDurations.length ? sortedDurations[sortedDurations.length - 1] : 0,
    weightMean: weights.length ? sum(weights) / weights.length : 0,
    weightMax: weights.reduce((acc, v) => Math.max(acc, v), 0),
    allWeightsOne: weights.every((w) => w === 1),
    peakSessions,
    peakWeight,
    durations: Float64Array.from(durations),
    weights: Float64Array.from(weights),
  };
}

// [0, 마지막 이벤트] 구간을 binCount개 안팎의 같은 폭 구간으로 나눠 집계한다.
export function buildTimeline(table: EventTable, binCount: number): Timeline {
  const endTime = table.length ? table.timestamp[table.length - 1] : 0;
  const binWidth = Math.max(1, Math.ceil((endTime + 1) / binCount));
  const bins = Math.max(1, Math.ceil((endTime + 1) / binWidth));
  const starts = Float64Array.from({ length: bins }, (_, b) => b * binWidth);
  const arrivals = new Float64Array(bins);
  const maxSessions = new Float64Array(bins);
  const maxWeight = new Float64Array(bins);

  const open = new Set<number>();
  let concurrent = 0;
  let load = 0;
  let bin = 0;
  for (let i = 0; i < table.length; i++) {
    const target = Math.floor(table.timestamp[i] / binWidth);
    // 이벤트가 없는 구간도 직전 수준을 이어받는다.
    while (bin < target) {
      bin++;
      maxSessions[bin] = concurrent;
      maxWeight[bin] = load;
    }
    const id = table.sessionId[i];
    if (table.connect[i]) {
      if (open.has(id)) continue;
      open.add(id);
      arrivals[bin]++;
      concurrent++;
      load += table.weight[i];
    } else {
      if (!open.delete(id)) continue;
      concurrent--;
      load -= table.weight[i];
    }
    maxSessions[bin] = Math.max(maxSessions[bin], concurrent);
    maxWeight[bin] = Math.max(maxWeight[bin], load);
  }
  return { binWidth, starts, arrivals, maxSessions, maxWeight };
}

// 지속 시간은 수 초에서 수 시간까지 퍼져 있으므로 로그 간격 구간을 쓴다.
export function durationHistogram(durations: Float64Array, binCount = 40): Histogram {
  const positive = durations.filter((d) => d > 0);
  if (positive.length === 0) return { lower: [], upper: [], counts: [], discrete: false };
  const min = positive.reduce((acc, v) => Math.min(acc, v), Infinity);
  const max = positive.reduce((acc, v) => Math.max(acc, v), 0);
  if (min === max) return { lower: [min], upper: [max], counts: [positive.length], discrete: false };

  const logMin = Math.log(min);
  const step = (Math.log(max) - logMin) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const d of positive) counts[Math.min(binCount - 1, Math.floor((Math.log(d) - logMin) / step))]++;
  const edge = (i: number) => Math.exp(logMin + step * i);
  return {
    lower: counts.map((_, i) => edge(i)),
    upper: counts.map((_, i) => (i === binCount - 1 ? max : edge(i + 1))),
    counts,
    discrete: false,
  };
}

// 서로 다른 값이 적으면 값별 개수, 많으면 정수 폭 구간으로 센다.
export function weightHistogram(weights: Float64Array, maxDiscrete = 40, binCount = 30): Histogram {
  const tally = new Map<number, number>();
  for (const w of weights) tally.set(w, (tally.get(w) ?? 0) + 1);
  if (tally.size <= maxDiscrete) {
    const values = [...tally.keys()].sort((a, b) => a - b);
    return { lower: values, upper: values, counts: values.map((v) => tally.get(v)!), discrete: true };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const value of tally.keys()) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const width = Math.ceil((max - min + 1) / binCount);
  const bins = Math.ceil((max - min + 1) / width);
  const counts = new Array<number>(bins).fill(0);
  for (const [value, count] of tally) counts[Math.floor((value - min) / width)] += count;
  return {
    lower: counts.map((_, i) => min + i * width),
    upper: counts.map((_, i) => Math.min(max, min + (i + 1) * width - 1)),
    counts,
    discrete: false,
  };
}
