import { describe, expect, it } from 'vitest';

import { CsvFormatError, parseCsv } from '../csv';
import { activeRangeEnd, bestValue, comparisonRow, utilizationHeatmap } from './analyze';
import { metric, parseAssignments, parseServers, parseSummary, parseTimeline, parseViolations } from './parse';
import { groupRuns, runsFromFiles } from './source';

// lb_simulator 출력 형식을 줄인 예
const SUMMARY = `metric,value
strategy,least_load
events_file,data/peak.csv
servers,"4x100,2x250"
connects,10
accepted,8
rejected,1
violations,1
rejection_rate,0.2
utilization_variance_mean,1.5e-05
select_ns_mean,43.5
param.strategy,"round_robin,least_load"
param.seed,3
`;

const TIMELINE = `time,active_sessions,total_load,utilization_mean,utilization_variance,accepted,rejected,violations,load_0,load_1
0,1,2,0.1,0.01,1,0,0,2,0
100,3,10,0.5,0.04,3,0,0,8,2
200,2,6,0.3,0.0,3,1,0,3,3
300,0,0,0,0,3,1,0,0,0
`;

const SERVERS = `server_id,capacity,accepted_sessions,peak_load,peak_utilization,mean_load,mean_utilization
0,10,2,8,0.8,4.5,0.45
1,5,1,3,0.6,1.5,0.3
`;

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"x,y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x,y', 'say "hi"'],
    ]);
  });
});

describe('parseSummary', () => {
  it('splits metrics, run settings and params', () => {
    const s = parseSummary(SUMMARY);
    expect(s.strategy).toBe('least_load');
    expect(s.servers).toBe('4x100,2x250');
    expect(metric(s, 'utilization_variance_mean')).toBe(1.5e-5);
    expect(metric(s, 'missing')).toBeNaN();
    expect(s.params.get('strategy')).toBe('round_robin,least_load');
  });

  it('requires the strategy row', () => {
    expect(() => parseSummary('metric,value\nconnects,1\n')).toThrow(CsvFormatError);
  });
});

describe('parseTimeline', () => {
  it('reads fixed columns and per-server loads', () => {
    const t = parseTimeline(TIMELINE);
    expect(t.length).toBe(4);
    expect([...t.totalLoad]).toEqual([2, 10, 6, 0]);
    expect(t.loads).toHaveLength(2);
    expect([...t.loads[1]]).toEqual([0, 2, 3, 0]);
  });

  it('reports missing columns and bad numbers', () => {
    expect(() => parseTimeline('time,total_load\n0,1\n')).toThrow(/열이 없다/);
    expect(() => parseTimeline(TIMELINE.replace('100,3,10', '100,3,x'))).toThrow(/3행: total_load/);
  });
});

describe('parseAssignments / parseViolations / parseServers', () => {
  it('maps outcomes to indexes', () => {
    const a = parseAssignments(
      'session_id,time,weight,server,outcome,select_ns\n1,5,1,0,accepted,100\n2,6,1,-1,rejected,0\n3,7,2,4,violation,100\n',
    );
    expect([...a.outcome]).toEqual([0, 1, 2]);
    expect([...a.selectNs]).toEqual([100, 0, 100]);
    expect(() => parseAssignments('session_id,time,weight,server,outcome,select_ns\n1,5,1,0,maybe,1\n')).toThrow(/outcome/);
  });

  it('reads violations with quoted reasons', () => {
    const v = parseViolations('session_id,time,weight,chosen_server,remaining,reason\n9,10,2,5,-1,"존재하지 않는, 서버"\n');
    expect(v).toEqual([{ sessionId: 9, time: 10, weight: 2, chosenServer: 5, remaining: -1, reason: '존재하지 않는, 서버' }]);
  });

  it('reads servers', () => {
    const s = parseServers(SERVERS);
    expect(s.length).toBe(2);
    expect([...s.capacity]).toEqual([10, 5]);
  });
});

describe('analysis', () => {
  it('finds the best value only when values differ', () => {
    const summary = parseSummary(SUMMARY);
    const a = comparisonRow(summary, 0);
    const b = { ...a, strategy: 'other', rejectionRate: 0.1 };
    expect(bestValue([a, b], 'rejectionRate', 'min')).toBe(0.1);
    expect(bestValue([a, b], 'accepted', 'max')).toBeUndefined(); // 모두 같다
    expect(bestValue([a], 'rejectionRate', 'min')).toBeUndefined();
  });

  it('builds a peak-preserving utilization heatmap', () => {
    const t = parseTimeline(TIMELINE);
    const servers = parseServers(SERVERS);
    const h = utilizationHeatmap(t, servers.capacity, 2); // 스냅샷 2개씩 묶는다
    expect(h.starts).toEqual([0, 200]);
    expect(h.ends).toEqual([100, 300]);
    expect(h.cells).toEqual([
      [0, 0, 0.8], // max(2, 8) / 10
      [0, 1, 0.4], // max(0, 2) / 5
      [1, 0, 0.3],
      [1, 1, 0.6],
    ]);
  });

  it('cuts a long idle tail from the initial range', () => {
    const t = parseTimeline(TIMELINE);
    expect(activeRangeEnd(t)).toBe(300); // 꼬리가 짧으면 전체
    const long = parseTimeline(
      TIMELINE.replace(/300,0,0.*\n$/, '300,1,0.1,0,0,3,1,0,0.1,0\n1000,0,0,0,0,3,1,0,0,0\n'),
    );
    expect(activeRangeEnd(long)).toBe(300);
  });
});

describe('local folders', () => {
  const file = (path: string, text = '') => {
    const f = new File([text], path.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: path });
    return f;
  };

  it('treats each directory with summary.csv as one run', async () => {
    const runs = runsFromFiles([
      file('results/peak/least_load/summary.csv', SUMMARY),
      file('results/peak/least_load/timeline.csv', TIMELINE),
      file('results/peak/random/summary.csv'),
      file('results/peak/notes.txt'),
      file('random/summary.csv'),
    ]);
    const groups = groupRuns(runs, 'local');
    // 그룹 순서는 로캘 정렬에 따르므로 내용만 비교한다.
    expect(groups.map((g) => [g.dataset, g.runs.map((r) => r.strategy)])).toEqual(
      expect.arrayContaining([
        ['peak', ['least_load', 'random']],
        ['로컬', ['random']],
      ]),
    );
    const peak = groups.find((g) => g.dataset === 'peak')!;
    expect(await peak.runs[0].read('timeline.csv')).toBe(TIMELINE);
    await expect(peak.runs[1].read('timeline.csv')).rejects.toThrow(/파일이 없다/);
  });
});
