# 로드 밸런싱 전략 시뮬레이션

여러 로드 밸런싱 전략을 같은 조건에서 시뮬레이션하고 결과를 비교한다. 요구 사항은 [PROJECT_SPEC.md](PROJECT_SPEC.md).

```
lb_generator ──(이벤트 CSV)──▶ lb_simulator ──(결과 CSV)──▶ dashboard
      └──────────────────(이벤트 CSV)───────────────────────▲
```

| 프로그램 | 위치 | 문서 |
| --- | --- | --- |
| 데이터 생성기 | `generator/` | [generator/README.md](generator/README.md) |
| 시뮬레이션 엔진 | `engine/` | [engine/README.md](engine/README.md) |
| 결과 분석 및 시각화 | `dashboard/` | [dashboard/README.md](dashboard/README.md) |
| 공통 모듈 | `common/` | 이벤트 CSV, 제약 검증, 설정(`key=value`), 난수, 레지스트리 |

## 빠른 시작

```bash
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure

build/generator/lb_generator scenario=peak sessions=20000           # data/peak.csv
build/engine/lb_simulator events=data/peak.csv servers=10x450 strategy=all   # results/peak/<전략>/
npm --prefix dashboard install
npm --prefix dashboard run dev                                       # http://localhost:5173
```
