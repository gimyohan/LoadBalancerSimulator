import { describe, expect, it } from 'vitest';

import { buildTimeline, durationHistogram, summarizeEvents, weightHistogram } from './analyze';
import { CsvFormatError, parseEventsCsv, sortByTimestamp } from './parse';
import { validateEvents } from './validate';

const csv = (rows: string[]) => ['session_id,type,timestamp,weight', ...rows].join('\n');

// 세션 1: 0~3000ms (가중치 2), 세션 2: 1000~2000ms (가중치 5), 세션 3: 4000~9000ms (가중치 1)
const SAMPLE = csv([
  '1,connect,0,2',
  '2,connect,1000,5',
  '2,disconnect,2000,5',
  '1,disconnect,3000,2',
  '3,connect,4000,1',
  '3,disconnect,9000,1',
]);

describe('parseEventsCsv', () => {
  it('reads rows into columns', () => {
    const table = parseEventsCsv(SAMPLE);
    expect(table.length).toBe(6);
    expect([...table.connect]).toEqual([1, 1, 0, 0, 1, 0]);
    expect(table.timestamp[5]).toBe(9000);
    expect(table.weight[1]).toBe(5);
  });

  it('accepts CRLF, BOM and a trailing newline', () => {
    const table = parseEventsCsv('﻿' + SAMPLE.replaceAll('\n', '\r\n') + '\r\n');
    expect(table.length).toBe(6);
  });

  it('reports the offending line', () => {
    expect(() => parseEventsCsv('id,type\n')).toThrow(CsvFormatError);
    expect(() => parseEventsCsv(csv(['1,join,0,1']))).toThrow(/2행/);
    expect(() => parseEventsCsv(csv(['1,connect,0,1', '1,disconnect,1.5,1']))).toThrow(/3행: timestamp/);
    expect(() => parseEventsCsv(csv(['1,connect,0']))).toThrow(/필드/);
  });
});

describe('sortByTimestamp', () => {
  it('orders rows by time', () => {
    const table = sortByTimestamp(parseEventsCsv(csv(['1,disconnect,50,1', '1,connect,10,1'])));
    expect([...table.timestamp]).toEqual([10, 50]);
    expect([...table.connect]).toEqual([1, 0]);
  });
});

describe('validateEvents', () => {
  it('accepts a valid dataset', () => {
    expect(validateEvents(parseEventsCsv(SAMPLE)).errorCount).toBe(0);
  });

  it('finds every kind of violation', () => {
    const table = sortByTimestamp(
      parseEventsCsv(
        csv([
          '1,connect,10,1', // 해제 없음
          '2,connect,20,1',
          '2,disconnect,20,1', // 같은 시각, 해제가 뒤가 아님
          '3,connect,30,2',
          '3,disconnect,40,3', // 가중치 불일치
          '4,connect,50,0',
          '4,disconnect,60,0', // 가중치 < 1
        ]),
      ),
    );
    const result = validateEvents(table);
    expect(result.messages.some((m) => m.includes('세션 1'))).toBe(true);
    expect(result.messages.some((m) => m.includes('두 개 이상'))).toBe(true);
    expect(result.messages.some((m) => m.includes('뒤가 아니다'))).toBe(true);
    expect(result.messages.some((m) => m.includes('가중치가 다르다'))).toBe(true);
    expect(result.messages.some((m) => m.includes('1보다 작다'))).toBe(true);
  });
});

describe('summarizeEvents', () => {
  it('computes durations, weights and peaks', () => {
    const s = summarizeEvents(parseEventsCsv(SAMPLE));
    expect(s.sessions).toBe(3);
    expect(s.endTime).toBe(9000);
    expect(s.lastArrival).toBe(4000);
    expect(s.bulkEnd).toBe(4000); // 6개 중 floor(0.99 * 5) = 4번째

    expect([...s.durations].sort((a, b) => a - b)).toEqual([1000, 3000, 5000]);
    expect(s.durationMedian).toBe(3000);
    expect(s.durationMean).toBe(3000);
    expect(s.weightMax).toBe(5);
    expect(s.allWeightsOne).toBe(false);
    expect(s.peakSessions).toEqual({ value: 2, at: 1000 });
    expect(s.peakWeight).toEqual({ value: 7, at: 1000 });
  });

  it('skips disconnects without a connect', () => {
    const s = summarizeEvents(parseEventsCsv(csv(['9,disconnect,5,1', '1,connect,10,1', '1,disconnect,20,1'])));
    expect(s.sessions).toBe(1);
    expect(s.peakSessions.value).toBe(1);
  });
});

describe('buildTimeline', () => {
  it('counts arrivals and tracks the per-bin maximum', () => {
    const t = buildTimeline(parseEventsCsv(SAMPLE), 10); // 폭 901ms, 구간 10개
    expect(t.binWidth).toBe(901);
    expect(t.starts.length).toBe(10);
    expect([...t.arrivals].reduce((a, b) => a + b, 0)).toBe(3);
    // 1000ms는 두 번째 구간 → 최대 동시 세션 2, 최대 총 가중치 7
    expect(t.maxSessions[1]).toBe(2);
    expect(t.maxWeight[1]).toBe(7);
    // 4000~9000ms에는 세션 3만 열려 있다. 이벤트가 없는 구간도 수준을 이어받는다.
    expect(t.maxSessions[6]).toBe(1);
    expect(t.maxWeight[7]).toBe(1);
  });
});

describe('histograms', () => {
  it('bins durations on a log scale', () => {
    // 경계: 10, 100, 1000, 10000 (최댓값은 마지막 구간에 포함)
    const h = durationHistogram(Float64Array.from([10, 50, 500, 5000, 10000]), 3);
    expect(h.counts).toEqual([2, 1, 2]);
    expect(h.lower[0]).toBeCloseTo(10);
    expect(h.upper[2]).toBe(10000);
  });

  it('lists weights individually when there are few values', () => {
    const h = weightHistogram(Float64Array.from([1, 1, 4, 2, 4, 4]));
    expect(h.discrete).toBe(true);
    expect(h.lower).toEqual([1, 2, 4]);
    expect(h.counts).toEqual([2, 1, 3]);
  });

  it('groups weights into ranges when there are many values', () => {
    const weights = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    const h = weightHistogram(weights, 40, 10);
    expect(h.discrete).toBe(false);
    expect(h.counts).toHaveLength(10);
    expect(h.counts.every((c) => c === 10)).toBe(true);
    expect([h.lower[0], h.upper[0]]).toEqual([1, 10]);
  });
});
