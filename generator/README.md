# 데이터 생성기 (`lb_generator`)

시나리오 설정을 받아 시뮬레이션 엔진과 대시보드가 읽을 이벤트 데이터셋(CSV)을 만든다.

## 빌드와 테스트

저장소 루트에서:

```bash
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure
```

실행 파일은 `build/generator/lb_generator(.exe)`다.

## 사용법

```bash
lb_generator --list                                   # 시나리오와 파라미터 목록
lb_generator scenario=peak sessions=20000 seed=7      # data/peak.csv 생성
lb_generator scenario=burst burst_at=0.3,0.7 output=data/burst2.csv
lb_generator --config configs/my.cfg seed=3           # 설정 파일 + 덮어쓰기
lb_generator scenario=uniform output=-                # 표준 출력으로
```

모든 설정은 `key=value`다. 인자는 앞에서부터 적용되고 같은 키는 나중 값이 이긴다.
설정 파일은 한 줄에 `key=value` 하나, `#` 뒤는 주석이다.
시나리오가 읽지 않는 키가 있으면 오타로 보고 오류를 낸다.

| 공통 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `scenario` | (필수) | 시나리오 이름 |
| `sessions` | 10000 | 생성할 세션 수 (정확히 이 수만큼 만든다) |
| `horizon` | 3600 | 연결이 도착하는 구간 길이(초). 해제는 이 구간 뒤로 넘어갈 수 있다 |
| `seed` | 1 | 난수 시드. 같은 설정과 시드는 어느 컴파일러에서든 같은 데이터셋을 만든다 |
| `output` | `data/<scenario>.csv` | 출력 경로. `-`면 표준 출력 |

생성이 끝나면 표준 에러로 요약(평균 지속 시간, 최대 동시 세션 수, 최대 총 가중치)을 출력한다.
서버 크기를 정할 때 참고하면 된다.

### 분포 spec

세션 지속 시간(초)과 가중치는 분포 spec 문자열로 지정한다. 가중치는 반올림하고 최소 1이다.

| spec | 의미 |
| --- | --- |
| `const:V` | 상수 |
| `uniform:LOW:HIGH` | 실수 균등 |
| `randint:LOW:HIGH` | 양 끝 포함 정수 균등 |
| `exp:MEAN` | 지수 분포 |
| `normal:MEAN:STDDEV` | 정규 분포 |
| `lognormal:MEDIAN:SIGMA` | 로그정규 (중앙값 기준) |
| `pareto:XMIN:ALPHA` | 파레토 (두꺼운 꼬리) |
| `discrete:V=P,V=P,...` | 이산 분포 (확률 자동 정규화) |

예: `weight=discrete:1=0.7,4=0.2,16=0.1`, `duration=pareto:10:1.5`

## 기본 시나리오

모든 기본 시나리오는 `duration`(기본 `lognormal:300:1.0`)과 `weight`(기본 `const:1`)를 받는다.
`mixed`만 `duration` 대신 단기/장기 분포를 따로 받는다.

| 이름 | 설명 | 전용 파라미터 |
| --- | --- | --- |
| `uniform` | 일정한 비율로 도착 | - |
| `peak` | 가우시안 모양의 피크 시간대 | `peak_center`(0.5, 여러 개 가능), `peak_width`(0.1), `peak_ratio`(5) |
| `burst` | 짧은 구간에 도착률이 급증 | `bursts`(3), `burst_at`(무작위), `burst_length`(0.01), `burst_ratio`(30) |
| `mixed` | 단기/장기 세션 혼합 | `short_ratio`(0.8), `short_duration`(`exp:30`), `long_duration`(`lognormal:1200:0.5`) |

위치와 길이 파라미터는 `horizon`에 대한 비율(0~1)이다.

## 출력 형식

```csv
session_id,type,timestamp,weight
1,connect,356,1
2,connect,526,1
```

- `timestamp`는 정수 ms이고 시뮬레이션 시작이 0이다. 행은 `timestamp` 오름차순이다.
- `session_id`는 연결 순서대로 1부터 매긴다. 세션마다 `connect` 하나와 `disconnect` 하나가 있고,
  두 행의 `weight`는 같다.
- 모든 `timestamp`는 서로 다르다. 반올림한 시각이 앞 이벤트와 겹치면 1ms씩 뒤로 민다.
  원래 순서는 유지되므로 해제는 항상 연결보다 뒤다.

검증 함수 `lb::validateEvents()`(`common/`)는 엔진에서도 입력 검사에 쓸 수 있다.

## 동작 방식

```
Params ──▶ ScenarioRegistry ──create──▶ Scenario::generate() ──▶ SessionSpec[] ──▶ buildEvents() ──▶ CSV
                                         (초 단위 실수 시각)                       (정수 ms, 고유 시각)
```

`IntensityScenario`는 연결 도착을 비균질 포아송 과정으로 본다. 세션 수 N이 정해지면 도착 시각은
강도 λ(t)에 비례하는 밀도에서 독립으로 뽑은 N개와 같으므로, 기각 샘플링으로 정확히 N개를 만든다.
시나리오는 λ(t)의 모양만 정하면 된다.

## 시나리오 추가하기

1. `src/scenarios/<이름>.cpp`를 만든다. CMake가 이 디렉터리를 자동으로 포함한다.
2. 도착 패턴만 다르면 `IntensityScenario`를 상속해 `intensity()`와 `maxIntensity()`를 구현한다.
   - 무작위 준비가 필요하면 `prepare()`를 재정의한다 (예: `burst`의 무작위 위치).
   - 시각에 따라 지속 시간이나 가중치가 달라지면 `sampleDuration()`, `sampleWeight()`를 재정의한다.
   - 도착 모델 자체가 다르면 `Scenario`를 직접 상속해 `generate()`를 구현한다.
3. `ScenarioInfo`(이름, 설명, 파라미터 설명, 생성 함수)를 돌려주는 함수를 만들어
   `src/scenarios/builtin.hpp`에 선언하고 `builtin.cpp`의 `makeBuiltinRegistry()`에 등록한다.
4. 테스트 `everyScenarioSatisfiesConstraints`와 `sameSeedIsReproducible`이 등록된 모든 시나리오를
   자동으로 검사한다.

```cpp
// src/scenarios/daily.cpp: 하루 주기로 도착률이 오르내리는 예
class DailyScenario final : public IntensityScenario {
public:
    explicit DailyScenario(const Params& p)
        : IntensityScenario(p, kDefaultDurationSpec), amplitude_(p.getDouble("amplitude", 0.8)) {}

protected:
    double intensity(double t, double) const override {
        return 1.0 + amplitude_ * std::sin(2.0 * std::numbers::pi * t / 86400.0);
    }
    double maxIntensity() const override { return 1.0 + amplitude_; }

private:
    double amplitude_;
};

ScenarioInfo dailyScenario() {
    auto params = sessionProfileParams(kDefaultDurationSpec);
    params.push_back({"amplitude", "0.8", "도착률 진폭 (0~1)"});
    return {"daily", "하루 주기 트래픽", std::move(params),
            [](const Params& p) { return std::make_unique<DailyScenario>(p); }};
}
```

새 분포는 `src/distribution.cpp`에 클래스를 만들고 `kKinds` 표에 한 줄 추가한다.
