// 히스토그램 집계. 이벤트 데이터셋과 시뮬레이션 결과 화면이 함께 쓴다.

export interface Histogram {
  lower: number[];
  upper: number[]; // discrete면 lower와 같다
  counts: number[];
  discrete: boolean;
}

// 값이 여러 자릿수에 걸쳐 퍼져 있을 때(지속 시간 등) 로그 간격 구간으로 센다.
export function logHistogram(values: Float64Array, binCount = 40): Histogram {
  const positive = values.filter((v) => v > 0);
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
export function valueHistogram(values: Float64Array, maxDiscrete = 40, binCount = 30): Histogram {
  const tally = new Map<number, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
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
