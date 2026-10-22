// 데이터 생성기의 이벤트 CSV(session_id,type,timestamp,weight)를 열 단위 배열로 읽는다.
// 수십만 행도 다루도록 객체 배열 대신 typed array를 쓴다. 시각 단위는 ms다.

import { CsvFormatError } from '../csv';

export { CsvFormatError };

export interface EventTable {
  length: number;
  sessionId: Float64Array;
  connect: Uint8Array; // 1 = connect, 0 = disconnect
  timestamp: Float64Array;
  weight: Float64Array;
}

export const EVENT_CSV_HEADER = 'session_id,type,timestamp,weight';

function parseInteger(text: string, line: number, field: string): number {
  const value = Number(text);
  if (text === '' || !Number.isSafeInteger(value)) {
    throw new CsvFormatError(`${line}행: ${field} 값이 정수가 아니다: '${text}'`);
  }
  return value;
}

export function parseEventsCsv(input: string): EventTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  let capacity = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) capacity++;
  const sessionId = new Float64Array(capacity);
  const connect = new Uint8Array(capacity);
  const timestamp = new Float64Array(capacity);
  const weight = new Float64Array(capacity);

  let n = 0;
  let lineNo = 0;
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    let line = text.slice(pos, end);
    pos = end + 1;
    lineNo++;
    if (line.endsWith('\r')) line = line.slice(0, -1);

    if (lineNo === 1) {
      if (line.trim() !== EVENT_CSV_HEADER) {
        throw new CsvFormatError(`헤더가 '${EVENT_CSV_HEADER}'가 아니다: '${line}'`);
      }
      continue;
    }
    if (line === '') continue;

    const fields = line.split(',');
    if (fields.length !== 4) throw new CsvFormatError(`${lineNo}행: 필드가 4개가 아니다`);
    const [id, type, ts, w] = fields;
    if (type !== 'connect' && type !== 'disconnect') {
      throw new CsvFormatError(`${lineNo}행: 알 수 없는 type '${type}'`);
    }
    sessionId[n] = parseInteger(id, lineNo, 'session_id');
    connect[n] = type === 'connect' ? 1 : 0;
    timestamp[n] = parseInteger(ts, lineNo, 'timestamp');
    weight[n] = parseInteger(w, lineNo, 'weight');
    n++;
  }
  if (lineNo === 0) throw new CsvFormatError('파일이 비어 있다');

  return {
    length: n,
    sessionId: sessionId.slice(0, n),
    connect: connect.slice(0, n),
    timestamp: timestamp.slice(0, n),
    weight: weight.slice(0, n),
  };
}

// 시각 순으로 정렬한 표를 돌려준다. 이미 정렬돼 있으면 그대로 돌려준다.
export function sortByTimestamp(table: EventTable): EventTable {
  const { length, timestamp } = table;
  let sorted = true;
  for (let i = 1; i < length && sorted; i++) sorted = timestamp[i - 1] <= timestamp[i];
  if (sorted) return table;

  const order = Uint32Array.from({ length }, (_, i) => i).sort(
    (a, b) => timestamp[a] - timestamp[b] || a - b,
  );
  const pick = <T extends Float64Array | Uint8Array>(source: T, target: T): T => {
    for (let i = 0; i < length; i++) target[i] = source[order[i]];
    return target;
  };
  return {
    length,
    sessionId: pick(table.sessionId, new Float64Array(length)),
    connect: pick(table.connect, new Uint8Array(length)),
    timestamp: pick(table.timestamp, new Float64Array(length)),
    weight: pick(table.weight, new Float64Array(length)),
  };
}
