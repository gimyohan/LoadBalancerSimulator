import type { EventTable } from './parse';

// 데이터셋 제약 조건을 검사한다. common/의 lb::validateEvents()와 같은 규칙이다.

export interface ValidationResult {
  errorCount: number;
  messages: string[]; // 앞쪽 일부만 담는다
}

const MAX_MESSAGES = 20;

interface SessionRecord {
  connects: number;
  disconnects: number;
  connectAt: number;
  disconnectAt: number;
  connectWeight: number;
  disconnectWeight: number;
}

// table은 시각 순으로 정렬돼 있어야 한다 (sortByTimestamp).
export function validateEvents(table: EventTable): ValidationResult {
  const result: ValidationResult = { errorCount: 0, messages: [] };
  const report = (message: string) => {
    result.errorCount++;
    if (result.messages.length < MAX_MESSAGES) result.messages.push(message);
  };

  const sessions = new Map<number, SessionRecord>();
  for (let i = 0; i < table.length; i++) {
    const id = table.sessionId[i];
    const ts = table.timestamp[i];
    const w = table.weight[i];
    if (i > 0 && table.timestamp[i - 1] === ts) report(`시각 ${ts}ms에 이벤트가 두 개 이상 있다`);
    if (ts < 0) report(`세션 ${id}: 시각이 음수다`);
    if (w < 1) report(`세션 ${id}: 가중치가 1보다 작다`);

    let r = sessions.get(id);
    if (!r) {
      r = { connects: 0, disconnects: 0, connectAt: 0, disconnectAt: 0, connectWeight: 0, disconnectWeight: 0 };
      sessions.set(id, r);
    }
    if (table.connect[i]) {
      r.connects++;
      r.connectAt = ts;
      r.connectWeight = w;
    } else {
      r.disconnects++;
      r.disconnectAt = ts;
      r.disconnectWeight = w;
    }
  }

  for (const [id, r] of sessions) {
    if (r.connects !== 1 || r.disconnects !== 1) {
      report(`세션 ${id}: 연결 ${r.connects}개, 해제 ${r.disconnects}개 (각각 1개여야 한다)`);
      continue;
    }
    if (r.disconnectAt <= r.connectAt) report(`세션 ${id}: 해제 시각이 연결 시각보다 뒤가 아니다`);
    if (r.connectWeight !== r.disconnectWeight) report(`세션 ${id}: 연결/해제 가중치가 다르다`);
  }
  return result;
}
