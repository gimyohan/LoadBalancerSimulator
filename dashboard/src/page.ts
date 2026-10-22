// 상단 탭으로 전환하는 페이지. 페이지 객체는 앱이 살아 있는 동안 유지되므로
// 탭을 오가도 불러온 데이터와 선택 상태가 남는다.

export interface PageContext {
  controls: HTMLElement; // 상단 바의 페이지 전용 컨트롤 영역
  content: HTMLElement;
  status: HTMLElement;
  // 현재 선택을 주소(#/<page>/<route>)에 반영한다. hashchange는 일으키지 않는다.
  setRoute(route: string): void;
}

export interface Page {
  readonly id: string;
  readonly title: string;
  readonly acceptsDrop: boolean;
  mount(context: PageContext, route: string): void;
  // 페이지가 열려 있는 동안 주소가 바뀌었을 때
  navigate(route: string): void;
  unmount(): void;
  refreshTheme(): void;
  dropFiles(files: FileList): void;
}

export function errorBanner(title: string, messages: string[]): string {
  const items = messages.map((m) => `<li>${m}</li>`).join('');
  return `<div class="status status-critical" role="alert">
      <p><span class="status-icon" aria-hidden="true">!</span>${title}</p>
      ${items ? `<ul>${items}</ul>` : ''}</div>`;
}
