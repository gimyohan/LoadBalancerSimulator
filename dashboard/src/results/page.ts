import { escapeHtml } from '../dom';
import { errorBanner, type Page, type PageContext } from '../page';
import {
  parseAssignments,
  parseServers,
  parseSummary,
  parseTimeline,
  parseViolations,
  parseWeightClasses,
  type ResultFile,
} from './parse';
import { fetchServerRuns, groupRuns, runsFromFiles, type ResultGroup, type ResultRun } from './source';
import { ResultsView, type DetailData, type LoadedRun } from './view';

const CONTROLS = `
  <label class="field">
    <span>결과</span>
    <select data-role="group"></select>
  </label>
  <button type="button" data-role="refresh" title="results/ 디렉터리를 다시 읽는다">새로고침</button>
  <button type="button" data-role="open" class="primary">폴더 열기</button>
  <input type="file" data-role="folder" webkitdirectory multiple hidden />`;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 시뮬레이션 결과 페이지. 주소: #/results/<그룹 키>/<상세 전략>
export class ResultsPage implements Page {
  readonly id = 'results';
  readonly title = '시뮬레이션 결과';
  readonly acceptsDrop = false;

  private context?: PageContext;
  private view?: ResultsView;
  private select?: HTMLSelectElement;
  private serverGroups: ResultGroup[] = [];
  private localGroups: ResultGroup[] = [];
  private listed = false;
  private activeKey?: string;
  private readonly hidden = new Map<string, Set<string>>(); // 그룹별 숨긴 전략
  private readonly detail = new Map<string, string>(); // 그룹별 상세 전략
  private cache = new WeakMap<ResultRun, Map<ResultFile, Promise<unknown>>>();
  private loadToken = 0;

  mount(context: PageContext, route: string) {
    this.context = context;
    context.controls.innerHTML = CONTROLS;
    const $ = <T extends HTMLElement>(role: string) => context.controls.querySelector<T>(`[data-role="${role}"]`)!;
    this.select = $<HTMLSelectElement>('group');
    const folder = $<HTMLInputElement>('folder');
    this.select.addEventListener('change', () => void this.show(this.select!.value));
    $('refresh').addEventListener('click', () => void this.reload());
    $('open').addEventListener('click', () => folder.click());
    folder.addEventListener('change', () => {
      this.addLocalFolder(folder.files ?? []);
      folder.value = '';
    });

    this.view = new ResultsView(context.content, {
      toggle: (strategy) => this.toggle(strategy),
      selectDetail: (strategy) => {
        if (this.activeKey) void this.show(this.activeKey, strategy);
      },
    });
    this.renderSelect();
    if (!this.listed) void this.reload(route);
    else this.navigate(route);
  }

  navigate(route: string) {
    const [key, strategy] = route.split('/').map(decodeURIComponent);
    const target = key || this.activeKey || this.groups()[0]?.key;
    if (target && this.findGroup(target)) void this.show(target, strategy || undefined);
    else if (key && key.startsWith('server:')) {
      // 목록을 읽은 뒤 새로 만든 결과일 수 있으니 results/ 목록을 다시 읽는다.
      void this.reloadList().then(() => {
        if (this.findGroup(key)) void this.show(key, strategy || undefined);
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

  dropFiles() {}

  private groups(): ResultGroup[] {
    return [...this.serverGroups, ...this.localGroups];
  }

  private findGroup(key: string): ResultGroup | undefined {
    return this.groups().find((g) => g.key === key);
  }

  private renderSelect() {
    const select = this.select!;
    const groups = this.groups();
    select.innerHTML = groups.length
      ? groups
          .map((g) => {
            const label = `${g.dataset} · 전략 ${g.runs.length}개${g.origin === 'local' ? ' (로컬)' : ''}`;
            return `<option value="${escapeHtml(g.key)}">${escapeHtml(label)}</option>`;
          })
          .join('')
      : '<option value="">결과 없음</option>';
    select.disabled = groups.length === 0;
    if (this.activeKey && this.findGroup(this.activeKey)) select.value = this.activeKey;
  }

  private showEmpty() {
    if (!this.context) return;
    this.view?.dispose();
    this.context.status.textContent = '';
    this.context.content.innerHTML = `<section class="empty">
        <h2>표시할 시뮬레이션 결과가 없다</h2>
        <p>시뮬레이션 엔진으로 <code>results/</code>에 결과를 만들고 새로고침하거나,<br />
        <b>폴더 열기</b>로 <code>results/&lt;데이터셋&gt;</code> 폴더를 고른다.</p>
        <p><code>lb_simulator events=data/peak.csv servers=10x450 strategy=all</code></p>
      </section>`;
  }

  private async reload(route = '') {
    await this.reloadList();
    this.cache = new WeakMap(); // 새로고침하면 결과 파일을 다시 읽는다
    if (this.context) this.navigate(route);
  }

  private async reloadList() {
    this.serverGroups = groupRuns(await fetchServerRuns(), 'server');
    this.listed = true;
    if (this.context) this.renderSelect();
  }

  private addLocalFolder(files: Iterable<File>) {
    const groups = groupRuns(runsFromFiles(files), 'local');
    if (groups.length === 0) {
      if (this.context) {
        this.context.status.textContent = '고른 폴더에 summary.csv가 있는 결과 디렉터리가 없다';
      }
      return;
    }
    const keys = new Set(groups.map((g) => g.key));
    this.localGroups = [...this.localGroups.filter((g) => !keys.has(g.key)), ...groups];
    this.renderSelect();
    void this.show(groups[0].key);
  }

  private toggle(strategy: string) {
    if (!this.activeKey) return;
    const hidden = this.hidden.get(this.activeKey) ?? new Set<string>();
    const group = this.findGroup(this.activeKey);
    if (hidden.has(strategy)) hidden.delete(strategy);
    else if (group && hidden.size < group.runs.length - 1) hidden.add(strategy); // 하나는 남긴다
    this.hidden.set(this.activeKey, hidden);
    void this.show(this.activeKey);
  }

  private load<T>(run: ResultRun, file: ResultFile, parse: (text: string) => T): Promise<T> {
    let files = this.cache.get(run);
    if (!files) this.cache.set(run, (files = new Map()));
    let promise = files.get(file) as Promise<T> | undefined;
    if (!promise) {
      promise = run.read(file).then(parse);
      files.set(file, promise);
      promise.catch(() => files!.delete(file)); // 실패는 다음에 다시 시도한다
    }
    return promise;
  }

  private async show(key: string, detailStrategy?: string) {
    const group = this.findGroup(key);
    const context = this.context;
    if (!group || !context) return;
    this.activeKey = key;
    this.select!.value = key;
    const token = ++this.loadToken;
    context.status.textContent = `${group.dataset} 결과 불러오는 중…`;

    const settled = await Promise.allSettled(
      group.runs.map(async (run, colorIndex): Promise<LoadedRun> => {
        const [summary, timeline, weightClasses] = await Promise.all([
          this.load(run, 'summary.csv', parseSummary),
          this.load(run, 'timeline.csv', parseTimeline),
          // 가중치 구간 지표를 쓰기 전의 결과에는 이 파일이 없다
          this.load(run, 'weight_classes.csv', parseWeightClasses).catch(() => undefined),
        ]);
        return { run, colorIndex, summary, timeline, weightClasses };
      }),
    );
    if (token !== this.loadToken) return;
    const runs: LoadedRun[] = [];
    const errors: string[] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') runs.push(result.value);
      else errors.push(`${group.runs[i].strategy}: ${message(result.reason)}`);
    });
    if (runs.length === 0) {
      this.view?.dispose();
      context.status.textContent = '';
      context.content.innerHTML = errorBanner(`${escapeHtml(group.dataset)} 결과를 읽지 못했다.`, errors.map(escapeHtml));
      return;
    }

    const wanted = detailStrategy ?? this.detail.get(key);
    const detailRun = runs.find((r) => r.summary.strategy === wanted) ?? runs[0];
    const strategy = detailRun.summary.strategy;
    this.detail.set(key, strategy);
    context.setRoute(`${encodeURIComponent(key)}/${encodeURIComponent(strategy)}`);

    let detail: DetailData | undefined;
    let detailError: string | undefined;
    try {
      const [servers, assignments, violations] = await Promise.all([
        this.load(detailRun.run, 'servers.csv', parseServers),
        this.load(detailRun.run, 'assignments.csv', parseAssignments),
        this.load(detailRun.run, 'violations.csv', parseViolations),
      ]);
      detail = { run: detailRun, servers, assignments, violations };
    } catch (error) {
      detailError = `${strategy} 상세를 읽지 못했다: ${message(error)}`;
    }
    if (token !== this.loadToken) return;

    context.status.textContent = `${group.origin === 'server' ? `results/${group.dataset}` : '로컬 폴더'} · 전략 ${runs.length}개`;
    this.view?.render({
      group,
      runs,
      errors,
      hidden: this.hidden.get(key) ?? new Set(),
      detail,
      detailError,
    });
  }
}
