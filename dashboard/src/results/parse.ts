import { CsvFormatError, CsvTable } from '../csv';

// 시뮬레이션 엔진(lb_simulator)이 results/<데이터셋>/<전략>/ 아래에 쓰는 CSV를 읽는다.
// 형식은 engine/README.md의 '결과 파일' 절과 같다.

export type ResultFile =
  | 'summary.csv'
  | 'servers.csv'
  | 'timeline.csv'
  | 'assignments.csv'
  | 'violations.csv'
  | 'weight_classes.csv';

// '?'가 붙은 필드는 그 지표를 쓰기 전의 엔진이 만든 결과에는 없다.

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
  acceptedWeight?: Float64Array;
  peakSessions?: Float64Array; // 최대 동시 세션 수
  hotTimeFraction?: Float64Array; // 이용률이 hot_threshold 이상이었던 시간 비율
  fullTimeFraction?: Float64Array; // 꽉 차 있던 시간 비율
  loadShare?: Float64Array; // 맡은 사용량-시간의 비율 (서버 합 = 1)
  capacityShare?: Float64Array; // 크기의 비율 (서버 합 = 1)
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
    acceptedWeight: t.optionalColumn('accepted_weight'),
    peakSessions: t.optionalColumn('peak_sessions'),
    hotTimeFraction: t.optionalColumn('hot_time_fraction'),
    fullTimeFraction: t.optionalColumn('full_time_fraction'),
    loadShare: t.optionalColumn('load_share'),
    capacityShare: t.optionalColumn('capacity_share'),
  };
}

export interface TimelineTable {
  length: number;
  time: Float64Array; // ms
  activeSessions: Float64Array;
  totalLoad: Float64Array;
  utilizationMean: Float64Array;
  utilizationVariance: Float64Array;
  imbalance?: Float64Array; // 최대/평균 이용률
  cv?: Float64Array; // 이용률 변동계수
  jain?: Float64Array; // Jain 공정성 지수
  connects?: Float64Array; // 누적
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
    imbalance: t.optionalColumn('imbalance'),
    cv: t.optionalColumn('cv'),
    jain: t.optionalColumn('jain'),
    connects: t.optionalColumn('connects'),
    accepted: t.column('accepted'),
    rejected: t.column('rejected'),
    violations: t.column('violations'),
    loads: loadColumns.map((name) => t.column(name)),
  };
}

export const OUTCOMES = ['accepted', 'rejected', 'violation'] as const;
// 전략이 거절한 요청의 원인. 0은 거절이 아님(또는 원인을 기록하기 전의 결과).
export const REJECT_REASONS = ['', 'capacity', 'fragmentation', 'avoidable'] as const;

export interface AssignmentTable {
  length: number;
  time: Float64Array;
  weight: Float64Array;
  server: Float64Array; // 거절이면 -1
  outcome: Uint8Array; // OUTCOMES의 인덱스
  rejectReason?: Uint8Array; // REJECT_REASONS의 인덱스
  selectNs: Float64Array;
  queries?: Float64Array; // 결정 동안 ClusterView 조회 수
  serversInspected?: Float64Array; // 결정 동안 살펴본 서버 수
}

export function parseAssignments(text: string): AssignmentTable {
  const t = new CsvTable(text, ['session_id', 'time', 'weight', 'server', 'outcome', 'select_ns'], 'assignments.csv');
  const outcome = Uint8Array.from(t.rows, (_, i) => {
    const index = OUTCOMES.indexOf(t.text(i, 'outcome') as (typeof OUTCOMES)[number]);
    if (index < 0) throw new CsvFormatError(`assignments.csv ${i + 2}행: 알 수 없는 outcome '${t.text(i, 'outcome')}'`);
    return index;
  });
  const rejectReason = t.has('reject_reason')
    ? Uint8Array.from(t.rows, (_, i) => {
        const index = REJECT_REASONS.indexOf(t.text(i, 'reject_reason') as (typeof REJECT_REASONS)[number]);
        if (index < 0) {
          throw new CsvFormatError(`assignments.csv ${i + 2}행: 알 수 없는 reject_reason '${t.text(i, 'reject_reason')}'`);
        }
        return index;
      })
    : undefined;
  return {
    length: t.rows.length,
    time: t.column('time'),
    weight: t.column('weight'),
    server: t.column('server'),
    outcome,
    rejectReason,
    selectNs: t.column('select_ns'),
    queries: t.optionalColumn('queries'),
    serversInspected: t.optionalColumn('servers_inspected'),
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

export interface WeightClassRow {
  weightMin: number;
  weightMax: number;
  requests: number;
  accepted: number;
  rejected: number;
  violations: number;
  rejectionRate: number; // (거절 + 위반) / 요청
}

export function parseWeightClasses(text: string): WeightClassRow[] {
  const t = new CsvTable(
    text,
    ['weight_min', 'weight_max', 'requests', 'accepted', 'rejected', 'violations', 'rejection_rate'],
    'weight_classes.csv',
  );
  return t.rows.map((_, i) => ({
    weightMin: t.number(i, 'weight_min'),
    weightMax: t.number(i, 'weight_max'),
    requests: t.number(i, 'requests'),
    accepted: t.number(i, 'accepted'),
    rejected: t.number(i, 'rejected'),
    violations: t.number(i, 'violations'),
    rejectionRate: t.number(i, 'rejection_rate'),
  }));
}
