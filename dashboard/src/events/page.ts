import { escapeHtml } from '../dom';
import { formatBytes } from '../format';
import { errorBanner, type Page, type PageContext } from '../page';
import { loadEventDataset, type EventDataset } from './dataset';
import { EventDatasetView } from './view';

// 데이터셋 출처: 개발 서버가 제공하는 data/ 디렉터리, 또는 사용자가 연 로컬 파일.
interface DatasetEntry {
  key: string;
  name: string;
  source: string;
  size: number;
  modified?: number;
  read(): Promise<string>;
  loaded?: EventDataset;
}

interface ServerDataset {
  name: string;
  size: number;
  modified: number;
}

const CONTROLS = `
  <label class="field">
    <span>데이터셋</span>
    <select data-role="dataset"></select>
  </label>
  <label class="field">
    <span>시간 구간</span>
    <select data-role="bins">
      <option value="100">100개</option>
      <option value="300" selected>300개</option>
      <option value="1000">1000개</option>
    </select>
  </label>
  <button type="button" data-role="refresh" title="data/ 디렉터리를 다시 읽는다">새로고침</button>
  <button type="button" data-role="open" class="primary">CSV 열기</button>
  <input type="file" data-role="file" accept=".csv,text/csv" multiple hidden />`;

async function fetchServerDatasets(): Promise<ServerDataset[]> {
  try {
    const response = await fetch('/api/datasets', { cache: 'no-store' });
    if (!response.ok) return [];
    const list: unknown = await response.json();
    return Array.isArray(list) ? (list as ServerDataset[]) : [];
  } catch {
    return []; // 정적 빌드처럼 API가 없으면 로컬 파일만 쓴다
  }
}

export class EventsPage implements Page {
  readonly id = 'events';
  readonly title = '이벤트 데이터셋';
  readonly acceptsDrop = true;

  private context?: PageContext;
  private view?: EventDatasetView;
  private select?: HTMLSelectElement;
  private readonly entries = new Map<string, DatasetEntry>();
  private activeKey?: string;
  private bins = 300;
  private loadToken = 0;
  private listed = false;

  mount(context: PageContext, route: string) {
    this.context = context;
    context.controls.innerHTML = CONTROLS;
    const $ = <T extends HTMLElement>(role: string) => context.controls.querySelector<T>(`[data-role="${role}"]`)!;
    this.select = $<HTMLSelectElement>('dataset');
    const bins = $<HTMLSelectElement>('bins');
    const fileInput = $<HTMLInputElement>('file');
    bins.value = String(this.bins);

    this.select.addEventListener('change', () => void this.activate(this.select!.value));
    bins.addEventListener('change', () => {
      this.bins = Number(bins.value);
      this.view?.setBins(this.bins);
    });
    $('refresh').addEventListener('click', () => void this.reload());
    $('open').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      this.addLocalFiles(fileInput.files ?? []);
      fileInput.value = '';
    });

    this.view = new EventDatasetView(context.content);
    this.view.setBins(this.bins);
    this.renderSelect();
    if (!this.listed) void this.reload(route);
    else this.navigate(route);
  }

  navigate(route: string) {
    const key = decodeURIComponent(route) || this.activeKey || this.entries.keys().next().value;
    if (key && this.entries.has(key)) void this.activate(key);
    else if (key) {
      // 목록에 없는 키면 그사이 생성된 파일일 수 있으니 data/ 목록을 다시 읽는다.
      void this.refreshServerDatasets().then(() => {
        if (this.entries.has(key)) void this.activate(key);
        else this.showEmpty();
      });
    } else this.showEmpty();
  }

  unmount() {
    this.loadToken++;
    this.view?.dispose();
    this.view = undefined;
    this.context = undefined;
  }

  refreshTheme() {
    this.view?.refreshTheme();
  }

  dropFiles(files: FileList) {
    this.addLocalFiles(files);
  }

  private renderSelect() {
    const select = this.select!;
    select.innerHTML = this.entries.size
      ? [...this.entries.values()]
          .map((e) => `<option value="${escapeHtml(e.key)}">${escapeHtml(e.name)}${e.key.startsWith('local:') ? ' (로컬)' : ''}</option>`)
          .join('')
      : '<option value="">데이터셋 없음</option>';
    select.disabled = this.entries.size === 0;
    if (this.activeKey && this.entries.has(this.activeKey)) select.value = this.activeKey;
  }

  private showEmpty() {
    if (!this.context) return;
    this.view?.dispose();
    this.context.status.textContent = '';
    this.context.content.innerHTML = `<section class="empty">
        <h2>표시할 데이터셋이 없다</h2>
        <p>데이터 생성기로 <code>data/</code>에 CSV를 만들고 새로고침하거나,<br />
        <b>CSV 열기</b> 또는 파일을 끌어다 놓아 불러온다.</p>
        <p><code>lb_generator scenario=peak sessions=20000</code></p>
      </section>`;
  }

  private async activate(key: string) {
    const entry = this.entries.get(key);
    const context = this.context;
    if (!entry || !context) return;
    this.activeKey = key;
    this.select!.value = key;
    context.setRoute(encodeURIComponent(key));

    const token = ++this.loadToken;
    if (!entry.loaded) {
      context.status.textContent = `${entry.name} 불러오는 중…`;
      try {
        const text = await entry.read();
        if (token !== this.loadToken) return;
        entry.loaded = loadEventDataset(entry.name, entry.source, text);
      } catch (error) {
        if (token !== this.loadToken) return;
        this.view?.dispose();
        context.status.textContent = '';
        const message = error instanceof Error ? error.message : String(error);
        context.content.innerHTML = errorBanner(`${escapeHtml(entry.name)}을(를) 읽지 못했다: ${escapeHtml(message)}`, []);
        return;
      }
    }
    if (token !== this.loadToken) return;
    context.status.textContent = `${entry.source} · ${formatBytes(entry.size)}`;
    this.view?.show(entry.loaded);
  }

  private async refreshServerDatasets() {
    // 서버 목록을 앞에 두고, 이미 연 로컬 파일은 뒤에 유지한다.
    const local = [...this.entries.values()].filter((e) => e.key.startsWith('local:'));
    const previous = new Map(this.entries);
    this.entries.clear();
    for (const d of await fetchServerDatasets()) {
      const key = `server:${d.name}`;
      const old = previous.get(key);
      this.entries.set(key, {
        key,
        name: d.name,
        source: 'data/ 디렉터리',
        size: d.size,
        modified: d.modified,
        read: async () => {
          const response = await fetch(`/api/datasets/${encodeURIComponent(d.name)}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        },
        // 파일이 그대로면 다시 파싱하지 않는다.
        loaded: old && old.size === d.size && old.modified === d.modified ? old.loaded : undefined,
      });
    }
    for (const e of local) this.entries.set(e.key, e);
    this.listed = true;
    if (this.select) this.renderSelect();
  }

  private addLocalFiles(files: Iterable<File>) {
    let last: string | undefined;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.csv')) continue;
      const key = `local:${file.name}`;
      this.entries.set(key, { key, name: file.name, source: '로컬 파일', size: file.size, read: () => file.text() });
      last = key;
    }
    if (this.select) this.renderSelect();
    if (last) void this.activate(last);
  }

  private async reload(route = '') {
    await this.refreshServerDatasets();
    if (this.context) this.navigate(route);
  }
}
