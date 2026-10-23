import { CsvFormatError, CsvTable } from '../csv';

// 시뮬레이션 엔진(lb_simulator)이 results/<데이터셋>/<전략>/ 아래에 쓰는 CSV를 읽는다.
// 형식은 engine/README.md의 '결과 파일' 절과 같다.

export type ResultFile = 'summary.csv' | 'servers.csv' | 'timeline.csv' | 'assignments.csv' | 'violations.csv';

export interface RunSummary {
  strategy: string;
  description: string; // 전략 설명. 설명을 기록하기 전의 엔진 결과면 빈 문자열
  strategyParams: Map<string, string>; // 전략 파라미터와 적용된 값
  eventsFile: string;
  servers: string;
  metrics: Map<string, number>; // 숫자 지표
  params: Map<string, string>; // param.* (실행 설정)
}

export function metric(summary: RunSummary, name: string): number {
  return summary.metrics.get(name) ?? NaN;
}

export function parseSummary(text: string): RunSummary {
  const table = new CsvTable(text, ['metric', 'value'], 'summary.csv');
  const summary: RunSummary = {
    strategy: '',
    description: '',
    strategyParams: new Map(),
    eventsFile: '',
    servers: '',
    metrics: new Map(),
    params: new Map(),
  };
  for (let i = 0; i < table.rows.length; i++) {
    const key = table.text(i, 'metric');
    const value = table.text(i, 'value');
    if (key === 'strategy') summary.strategy = value;
    else if (key === 'strategy_description') summary.description = value;
    else if (key.startsWith('strategy_param.')) summary.strategyParams.set(key.slice('strategy_param.'.length), value);
    else if (key === 'events_file') summary.eventsFile = value;
    else if (key === 'servers') summary.servers = value;
    else if (key.startsWith('param.')) summary.params.set(key.slice('param.'.length), value);
    else if (value !== '' && Number.isFinite(Number(value))) summary.metrics.set(key, Number(value));
  }
  if (!summary.strategy) throw new CsvFormatError('summary.csv: strategy 행이 없다');
  return summary;
}

export interface ServerTable {
  length: number;
  capacity: Float64Array;
  acceptedSessions: Float64Array;
  peakLoad: Float64Array;
  peakUtilization: Float64Array;
  meanLoad: Float64Array;
  meanUtilization: Float64Array;
}

export function parseServers(text: string): ServerTable {
  const t = new CsvTable(
    text,
    ['server_id', 'capacity', 'accepted_sessions', 'peak_load', 'peak_utilization', 'mean_load', 'mean_utilization'],
    'servers.csv',
  );
  return {
    length: t.rows.length,
    capacity: t.column('capacity'),
    acceptedSessions: t.column('accepted_sessions'),
    peakLoad: t.column('peak_load'),
    peakUtilization: t.column('peak_utilization'),
    meanLoad: t.column('mean_load'),
    meanUtilization: t.column('mean_utilization'),
  };
}

export interface TimelineTable {
  length: number;
  time: Float64Array; // ms
  activeSessions: Float64Array;
  totalLoad: Float64Array;
  utilizationMean: Float64Array;
  utilizationVariance: Float64Array;
  accepted: Float64Array; // 누적
  rejected: Float64Array; // 누적
  violations: Float64Array; // 누적
  loads: Float64Array[]; // 서버별 사용량 (load_0, load_1, ...)
}

export function parseTimeline(text: string): TimelineTable {
  const t = new CsvTable(
    text,
    ['time', 'active_sessions', 'total_load', 'utilization_mean', 'utilization_variance', 'accepted', 'rejected', 'violations'],
    'timeline.csv',
  );
  const loadColumns: string[] = [];
  for (let id = 0; t.has(`load_${id}`); id++) loadColumns.push(`load_${id}`);
  return {
    length: t.rows.length,
    time: t.column('time'),
    activeSessions: t.column('active_sessions'),
    totalLoad: t.column('total_load'),
    utilizationMean: t.column('utilization_mean'),
    utilizationVariance: t.column('utilization_variance'),
    accepted: t.column('accepted'),
    rejected: t.column('rejected'),
    violations: t.column('violations'),
    loads: loadColumns.map((name) => t.column(name)),
  };
}

export const OUTCOMES = ['accepted', 'rejected', 'violation'] as const;

export interface AssignmentTable {
  length: number;
  time: Float64Array;
  weight: Float64Array;
  server: Float64Array; // 거절이면 -1
  outcome: Uint8Array; // OUTCOMES의 인덱스
  selectNs: Float64Array;
}

export function parseAssignments(text: string): AssignmentTable {
  const t = new CsvTable(text, ['session_id', 'time', 'weight', 'server', 'outcome', 'select_ns'], 'assignments.csv');
  const outcome = Uint8Array.from(t.rows, (_, i) => {
    const index = OUTCOMES.indexOf(t.text(i, 'outcome') as (typeof OUTCOMES)[number]);
    if (index < 0) throw new CsvFormatError(`assignments.csv ${i + 2}행: 알 수 없는 outcome '${t.text(i, 'outcome')}'`);
    return index;
  });
  return {
    length: t.rows.length,
    time: t.column('time'),
    weight: t.column('weight'),
    server: t.column('server'),
    outcome,
    selectNs: t.column('select_ns'),
  };
}

export interface ViolationRow {
  sessionId: number;
  time: number;
  weight: number;
  chosenServer: number;
  remaining: number; // 존재하지 않는 서버면 -1
  reason: string;
}

export function parseViolations(text: string): ViolationRow[] {
  const t = new CsvTable(
    text,
    ['session_id', 'time', 'weight', 'chosen_server', 'remaining', 'reason'],
    'violations.csv',
  );
  return t.rows.map((_, i) => ({
    sessionId: t.number(i, 'session_id'),
    time: t.number(i, 'time'),
    weight: t.number(i, 'weight'),
    chosenServer: t.number(i, 'chosen_server'),
    remaining: t.number(i, 'remaining'),
    reason: t.text(i, 'reason'),
  }));
}
