import type { ResultFile } from './parse';

// 결과 출처: 개발 서버가 제공하는 results/ 디렉터리, 또는 사용자가 연 로컬 폴더.
// 한 데이터셋에 대해 여러 전략을 실행한 결과(results/<데이터셋>/<전략>/)를 그룹으로 묶는다.

export interface ResultRun {
  dataset: string;
  strategy: string;
  read(file: ResultFile): Promise<string>;
}

export interface ResultGroup {
  key: string;
  dataset: string;
  origin: 'server' | 'local';
  runs: ResultRun[]; // 전략 이름 순
}

interface ServerRun {
  dataset: string;
  strategy: string;
}

export async function fetchServerRuns(): Promise<ResultRun[]> {
  try {
    const response = await fetch('/api/results', { cache: 'no-store' });
    if (!response.ok) return [];
    const list: unknown = await response.json();
    if (!Array.isArray(list)) return [];
    return (list as ServerRun[]).map(({ dataset, strategy }) => ({
      dataset,
      strategy,
      read: async (file) => {
        const path = [dataset, strategy, file].map(encodeURIComponent).join('/');
        const response = await fetch(`/api/results/${path}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
        return response.text();
      },
    }));
  } catch {
    return []; // 정적 빌드처럼 API가 없으면 로컬 폴더만 쓴다
  }
}

// 폴더 선택(webkitdirectory)으로 받은 파일들. summary.csv가 있는 디렉터리 하나가 전략 실행 하나이고,
// 그 상위 디렉터리 이름을 데이터셋으로 본다. 전략 디렉터리 하나만 고르면 데이터셋은 '로컬'이다.
export function runsFromFiles(files: Iterable<File>): ResultRun[] {
  const byDirectory = new Map<string, Map<string, File>>();
  for (const file of files) {
    const path = (file.webkitRelativePath || file.name).split('/');
    const directory = path.slice(0, -1).join('/');
    if (!byDirectory.has(directory)) byDirectory.set(directory, new Map());
    byDirectory.get(directory)!.set(path[path.length - 1], file);
  }

  const runs: ResultRun[] = [];
  for (const [directory, entries] of byDirectory) {
    if (!entries.has('summary.csv')) continue;
    const parts = directory.split('/').filter(Boolean);
    runs.push({
      dataset: parts.length >= 2 ? parts[parts.length - 2] : '로컬',
      strategy: parts[parts.length - 1] ?? 'unknown',
      read: async (name) => {
        const file = entries.get(name);
        if (!file) throw new Error(`${directory}/${name} 파일이 없다`);
        return file.text();
      },
    });
  }
  return runs;
}

export function groupRuns(runs: ResultRun[], origin: ResultGroup['origin']): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  for (const run of runs) {
    const key = `${origin}:${run.dataset}`;
    if (!groups.has(key)) groups.set(key, { key, dataset: run.dataset, origin, runs: [] });
    groups.get(key)!.runs.push(run);
  }
  for (const group of groups.values()) group.runs.sort((a, b) => a.strategy.localeCompare(b.strategy));
  return [...groups.values()].sort((a, b) => a.dataset.localeCompare(b.dataset));
}
