// 표시용 서식. 시각과 지속 시간은 모두 ms 단위로 받는다.

const integer = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });

export const formatInt = (n: number) => integer.format(n);
export const formatNumber = (n: number) => decimal.format(n);

// 850ms, 12.3초, 5분 20초, 1시간 02분
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}초`;
  const totalSeconds = Math.round(s);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  if (h > 0) return `${h}시간 ${String(m).padStart(2, '0')}분`;
  return sec ? `${m}분 ${sec}초` : `${m}분`;
}

// 시뮬레이션 시각을 h:mm:ss 또는 m:ss로
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = String(totalSeconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 시각 표시 방식. 1분이 안 되는 짧은 데이터셋은 m:ss로는 모두 0:00이 되므로 ms/초로 쓴다.
export function timeFormatter(endTime: number): (ms: number) => string {
  return endTime < 60_000 ? formatDuration : formatClock;
}
