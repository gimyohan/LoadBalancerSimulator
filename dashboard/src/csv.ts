// 따옴표로 감싼 필드를 지원하는 범용 CSV 읽기. 크기가 큰 이벤트 CSV는 events/parse.ts의
// 전용 파서를 쓰고, 결과 CSV처럼 수만 행 이하인 파일은 이것을 쓴다.

export class CsvFormatError extends Error {}

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

// 헤더 이름으로 열을 찾는 표. 필요한 열이 없으면 CsvFormatError.
export class CsvTable {
  readonly header: string[];
  readonly rows: string[][];
  private readonly index = new Map<string, number>();

  constructor(text: string, required: readonly string[], private readonly context: string) {
    const rows = parseCsv(text);
    if (rows.length === 0) throw new CsvFormatError(`${context}: 파일이 비어 있다`);
    this.header = rows[0];
    this.rows = rows.slice(1);
    this.header.forEach((name, i) => this.index.set(name, i));
    const missing = required.filter((name) => !this.index.has(name));
    if (missing.length) throw new CsvFormatError(`${context}: 열이 없다: ${missing.join(', ')}`);
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  text(row: number, name: string): string {
    return this.rows[row][this.index.get(name)!] ?? '';
  }

  number(row: number, name: string): number {
    const text = this.text(row, name);
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) {
      throw new CsvFormatError(`${this.context} ${row + 2}행: ${name} 값이 숫자가 아니다: '${text}'`);
    }
    return value;
  }

  column(name: string): Float64Array {
    return Float64Array.from(this.rows, (_, i) => this.number(i, name));
  }
}
