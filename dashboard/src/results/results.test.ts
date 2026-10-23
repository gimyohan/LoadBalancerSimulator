import { describe, expect, it } from 'vitest';

import { CsvFormatError, parseCsv } from '../csv';
import {
  activeRangeEnd,
  bestValue,
  comparisonRow,
  utilizationHeatmap,
  weightClassLabel,
  windowedRejectionRate,
} from './analyze';
import {
  REJECT_REASONS,
  metric,
  parseAssignments,
  parseServers,
  parseSummary,
  parseTimeline,
  parseViolations,
  parseWeightClasses,
} from './parse';
import { groupRuns, runsFromFiles } from './source';

// lb_simulator 출력 형식을 줄인 예
const SUMMARY = `metric,value
strategy,least_load
strategy_description,"최소 이용률: 사용량/크기 비율이 가장 낮은 서버를 고른다"
strategy_param.seed,1
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
    expect(s.description).toBe('최소 이용률: 사용량/크기 비율이 가장 낮은 서버를 고른다');
    expect(s.strategyParams.get('seed')).toBe('1');
    expect(s.params.get('seed')).toBe('3'); // strategy_param.*과 param.*은 따로 모은다
  });

  it('accepts results written before descriptions existed', () => {
    const s = parseSummary('metric,value\nstrategy,random\nconnects,1\n');
    expect(s.description).toBe('');
    expect(s.strategyParams.size).toBe(0);
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

describe('balance, rejection and cost metrics', () => {
  // 균형 지수와 누적 연결 수 열이 있는 현재 형식
  const NEW_TIMELINE = `time,active_sessions,total_load,utilization_mean,utilization_variance,imbalance,cv,jain,connects,accepted,rejected,violations,load_0
0,0,0,0,0,1,0,1,0,0,0,0,0
100,5,5,0.5,0,1.5,0.4,0.9,10,10,0,0,5
200,5,5,0.5,0,2,0.6,0.8,30,25,4,1,5
300,0,0,0,0,1,0,1,40,25,14,1,0
`;

  it('reads the new timeline columns', () => {
    const t = parseTimeline(NEW_TIMELINE);
    expect([...t.imbalance!]).toEqual([1, 1.5, 2, 1]);
    expect([...t.jain!]).toEqual([1, 0.9, 0.8, 1]);
    expect([...t.connects!]).toEqual([0, 10, 30, 40]);
  });

  it('leaves the new columns undefined for older results', () => {
    const t = parseTimeline(TIMELINE);
    expect(t.imbalance).toBeUndefined();
    expect(t.connects).toBeUndefined();
    expect(windowedRejectionRate(t)).toBeUndefined();
    const s = parseServers(SERVERS);
    expect(s.hotTimeFraction).toBeUndefined();
  });

  it('computes the rejection rate per window', () => {
    const t = parseTimeline(NEW_TIMELINE);
    // 스냅샷 하나씩: 10건 중 0, 20건 중 5, 10건 중 10
    expect(windowedRejectionRate(t, 3)).toEqual([
      [100, 0],
      [200, 0.25],
      [300, 1],
    ]);
    // 두 구간으로 묶으면 첫 구간은 30건 중 5
    expect(windowedRejectionRate(t, 2)).toEqual([
      [200, 5 / 30],
      [300, 1],
    ]);
  });

  it('reads reject reasons and decision cost', () => {
    const a = parseAssignments(
      'session_id,time,weight,server,outcome,reject_reason,select_ns,queries,servers_inspected\n' +
        '1,5,1,0,accepted,,100,4,4\n2,6,2,-1,rejected,fragmentation,0,8,4\n3,7,1,-1,rejected,avoidable,0,2,2\n',
    );
    expect([...a.rejectReason!].map((i) => REJECT_REASONS[i])).toEqual(['', 'fragmentation', 'avoidable']);
    expect([...a.serversInspected!]).toEqual([4, 4, 2]);
    expect(() =>
      parseAssignments('session_id,time,weight,server,outcome,reject_reason,select_ns\n1,5,1,-1,rejected,bogus,0\n'),
    ).toThrow(/reject_reason/);
  });

  it('reads weight classes and labels them', () => {
    const w = parseWeightClasses(
      'weight_min,weight_max,requests,accepted,rejected,violations,rejection_rate,requested_weight,rejected_weight\n' +
        '1,1,100,100,0,0,0,100,0\n16,31,20,18,2,0,0.1,320,32\n',
    );
    expect(w.map((c) => weightClassLabel(c.weightMin, c.weightMax))).toEqual(['1', '16–31']);
    expect(w[1].rejectionRate).toBe(0.1);
  });

  it('reads the new summary metrics into comparison rows', () => {
    const s = parseSummary(SUMMARY + 'imbalance_mean,1.25\njain_mean,0.95\nrejected_fragmentation,3\ndecision_servers_mean,2\n');
    const row = comparisonRow(s, 0);
    expect(row.imbalanceMean).toBe(1.25);
    expect(row.jainMean).toBe(0.95);
    expect(row.rejectedFragmentation).toBe(3);
    expect(row.decisionServersMean).toBe(2);
    expect(row.cvMean).toBeNaN(); // 없는 지표
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
