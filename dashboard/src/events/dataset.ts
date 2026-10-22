import { summarizeEvents, type EventSummary } from './analyze';
import { parseEventsCsv, sortByTimestamp, type EventTable } from './parse';
import { validateEvents, type ValidationResult } from './validate';

export interface EventDataset {
  name: string;
  source: string; // 표시용 출처 (data/ 디렉터리, 로컬 파일 등)
  table: EventTable;
  summary: EventSummary;
  validation: ValidationResult;
}

// CSV 형식 오류는 CsvFormatError로 던지고, 제약 조건 위반은 validation에 담아 그대로 보여준다.
export function loadEventDataset(name: string, source: string, csv: string): EventDataset {
  const table = sortByTimestamp(parseEventsCsv(csv));
  return { name, source, table, summary: summarizeEvents(table), validation: validateEvents(table) };
}
