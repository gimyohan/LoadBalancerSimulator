# 시뮬레이션 엔진 (`lb_simulator`)

이벤트 데이터셋을 시각 순으로 재생하며 전략에 서버를 고르게 하고, 결과를 CSV로 정리한다.

## 빌드와 테스트

저장소 루트에서 (생성기와 함께 빌드된다):

```bash
cmake -S . -B build -G Ninja
cmake --build build
ctest --test-dir build --output-on-failure
```

실행 파일은 `build/engine/lb_simulator(.exe)`다.

## 사용법

```bash
lb_simulator --list                                                  # 전략과 파라미터 목록
lb_simulator events=data/peak.csv servers=10x450 strategy=least_load
lb_simulator events=data/peak.csv servers=4x1000,4x2000 strategy=all seed=3
lb_simulator events=data/burst.csv servers=8x700 strategy=round_robin,power_of_two choices=3
```

| 파라미터 | 기본값 | 설명 |
| --- | --- | --- |
| `events` | (필수) | 이벤트 데이터셋 CSV. 읽은 뒤 시각 순으로 정렬하고 제약 조건을 검사한다 |
| `servers` | (필수) | 서버 구성. `크기` 또는 `개수x크기`를 쉼표로 나열. 서버 ID는 이 순서대로 0부터 |
| `strategy` | (필수) | 전략 이름. 쉼표로 여러 개, `all`이면 전체. 전략마다 같은 데이터로 따로 실행한다 |
| `output` | `results/<events 파일 이름>` | 결과 디렉터리. 전략마다 하위 디렉터리를 만든다 |
| `sample_interval` | 0 | 사용량 스냅샷 간격(ms). 0이면 `samples`에 맞춰 자동 |
| `samples` | 1000 | 자동 간격일 때 스냅샷 수 |
| `hot_threshold` | 0.9 | 서버를 '포화에 가깝다'고 볼 이용률. 서버별 포화 시간에 쓴다 |

전략 파라미터(`seed`, `choices` 등)도 같은 `key=value`로 넘기고, 지정한 모든 전략에 적용된다.
`--config FILE`, 읽지 않는 키를 오타로 보고 오류를 내는 동작은 생성기와 같다.

실행이 끝나면 표준 에러로 전략별 요약 표를 출력한다.

## 처리 규칙

| 이벤트 | 처리 |
| --- | --- |
| 연결 | 전략의 `selectServer()`가 서버를 고르고 엔진이 그 서버에 가중치를 더한다. 선택 시간은 wall-clock으로 잰다 |
| 연결 해제 | 엔진이 세션이 할당된 서버에서 가중치를 뺀다. 거절되거나 위반으로 처리된 세션의 해제는 무시한다 |

- 전략이 `std::nullopt`를 돌려주면 **거절**이다.
- 범위를 벗어난 서버 ID나 남은 용량이 세션 가중치보다 작은 서버를 고르면 **위반**이다.
  엔진은 할당하지 않고 거절과 같이 처리하며, `violations.csv`에 내역을 남긴다.
- 거절률은 `(거절 + 위반) / 연결 요청 수`다.
- 전략이 거절하면 그 순간의 클러스터 상태로 원인을 나눈다.

| 거절 원인 | 조건 | 의미 |
| --- | --- | --- |
| `capacity` | 전체 남은 용량 < 세션 가중치 | 어떤 전략도 받을 수 없었다 |
| `fragmentation` | 전체 남은 용량은 충분하지만 들어갈 서버가 없다 | 세션을 옮겼다면 받을 수 있었다 |
| `avoidable` | 들어갈 서버가 있었는데 전략이 거절했다 | 전략 탓 (예: power_of_two의 후보가 모두 찼다) |

## 결과 파일

`results/<데이터셋>/<전략>/` 아래에 여섯 파일을 쓴다.

| 파일 | 내용 |
| --- | --- |
| `summary.csv` | `metric,value`. 아래 지표와 실행 설정(`param.*`) |
| `servers.csv` | 서버별 크기, 수락 세션 수·가중치, 최대/평균 사용량과 이용률, 최대 동시 세션 수, `hot_threshold` 이상·꽉 찬 시간(ms와 비율), 사용량 몫·용량 몫 |
| `timeline.csv` | 시각별 스냅샷: 활성 세션 수, 총 사용량, 이용률 평균·분산, 균형 지수(`imbalance`, `cv`, `jain`), 누적 연결/수락/거절/위반, 서버별 사용량(`load_<id>`) |
| `assignments.csv` | 연결 요청별 서버, 결과(`accepted`/`rejected`/`violation`), 거절 원인, 선택 소요 시간(ns), 조회 수, 살펴본 서버 수 |
| `violations.csv` | 위반 요청의 세션, 시각, 가중치, 고른 서버, 그 서버의 남은 용량, 사유 |
| `weight_classes.csv` | 가중치 구간(1, 2–3, 4–7, ...)별 요청·수락·거절·위반 수와 거절률 |

### summary.csv 지표

| 지표 | 의미 |
| --- | --- |
| `strategy`, `strategy_description`, `strategy_param.*` | 전략 이름, 설명(`StrategyInfo::description`), 전략 파라미터와 적용된 값 |
| `connects`, `accepted`, `rejected`, `violations`, `rejected_total`, `rejection_rate` | 요청 처리 결과 |
| `rejected_capacity`, `rejected_fragmentation`, `rejected_avoidable` | 거절 원인별 수 (위 표) |
| `requested_weight`, `rejected_weight`, `weighted_rejection_rate` | 가중치 기준 거절률. 요청 수 거절률보다 크면 큰 세션이 더 자주 밀려난다 |
| `utilization_mean` | 서버 평균 이용률(사용량/크기)의 시간 가중 평균 |
| `utilization_variance_mean` | 서버 간 이용률 분산의 시간 가중 평균. 순간적인 불균형 |
| `server_utilization_variance` | 서버별 평균 이용률의 분산. 장기적인 불균형 |
| `peak_total_load` | 전체 사용량의 최댓값 |
| `imbalance_{mean,p95,p99}` | 최대/평균 이용률(과잉 확보 계수). 1이 완전 균형 |
| `cv_{mean,p95,p99}` | 이용률 변동계수(표준편차/평균). 0이 완전 균형 |
| `jain_{mean,p05,p01}` | Jain 공정성 지수 (Σu)²/(n·Σu²). 1이 완전 균형이고 낮을수록 나쁘므로 아래쪽 분위수를 쓴다 |
| `hot_threshold`, `hot_time_fraction`, `full_time_fraction` | 서버들이 `hot_threshold` 이상·꽉 찬 상태였던 시간 비율 (서버 × 시간 평균) |
| `select_ns_{mean,min,p50,p95,p99,max,total}` | 서버 선택 소요 시간 |
| `timer_resolution_ns`, `timer_overhead_ns` | 시간 측정 환경 (아래 참고) |
| `decision_queries_{mean,p99,max}` | 결정 하나에서 `ClusterView`를 조회한 횟수 |
| `decision_servers_{mean,p99,max}` | 결정 하나에서 살펴본 서로 다른 서버 수. 시계와 무관한 결정 비용 |

균형 지수(`imbalance`, `cv`, `jain`)의 평균과 분위수는 **그 순간의 총 사용량 × 지속 시간**으로 가중한다.
세션이 몇 개뿐인 한산한 순간에는 최대/평균이 서버 수만큼 커지는데, 이런 순간이 결과를 좌우하지 않게 하려는 것이다.
부하가 전혀 없는 순간은 완전 균형(1, 0, 1)으로 보고 가중치는 0이다.

결정 비용은 전략이 `ClusterView`를 통해 서버를 조회할 때마다 센다. 엔진이 위반을 확인하거나 거절 원인을
판정하려고 서버를 보는 것은 세지 않는다.

시간 가중 평균은 첫 이벤트부터 마지막 이벤트까지 구간에서 계산한다. 이벤트 사이에는 상태가 변하지 않으므로
구간 길이로 가중하면 정확한 적분이 된다.

### 선택 시간 측정의 한계

선택은 보통 수십 ns로 끝나므로 쿼리별 값은 시계 해상도(`timer_resolution_ns`)에 묶인다.
Windows의 `steady_clock`은 100ns 단위라 쿼리별 값은 대부분 0 또는 100으로 찍히고, p50·p99 같은 분위수는
거칠다. 많은 쿼리를 평균한 `select_ns_mean`이 전략 간 비교에 더 믿을 만하다.

## 구조

```
src/strategy.hpp         Strategy 인터페이스, ClusterView(서버 현황 조회), ConnectRequest
src/strategies/          기본 전략 (CMake가 자동으로 포함)
src/simulation.*         이벤트 재생, 위반 감지, 사용량 적분, 스냅샷, 시간 측정
src/result_writer.*      결과 CSV
src/server_spec.*        servers 표기 해석
src/main.cpp             CLI
tests/engine_tests.cpp   단위 테스트
```

## 기본 전략

| 이름 | 방식 | 파라미터 |
| --- | --- | --- |
| `round_robin` | 순서대로 돌며 들어가는 다음 서버 | - |
| `blind_round_robin` | 용량을 보지 않는 라운드 로빈. 위반 감지 확인용 기준선 | - |
| `random` | 들어가는 서버 중 균등 무작위 | `seed` |
| `least_connections` | 세션 수가 가장 적은 서버 | - |
| `least_load` | 이용률(사용량/크기)이 가장 낮은 서버 | - |
| `first_fit` | ID 순으로 들어가는 첫 서버 | - |
| `best_fit` | 넣은 뒤 남는 용량이 가장 작은 서버 | - |
| `power_of_two` | 무작위 후보 d개(중복 허용) 중 이용률이 가장 낮은 서버. 후보가 모두 차 있으면 거절 | `choices`(2), `seed` |
| `power_of_four` | 무작위 후보 4개(중복 허용) 중 이용률이 가장 낮은 서버. 후보가 모두 차 있으면 거절 | `seed` |
| `power_of_eight` | 무작위 후보 8개(중복 허용) 중 이용률이 가장 낮은 서버. 후보가 모두 차 있으면 거절 | `seed` |
| `feasible_power_of_two` | 들어갈 수 있는 서버만 모아 그중 서로 다른 둘을 무작위로 골라 이용률이 낮은 쪽. 들어갈 서버가 있으면 거절하지 않지만 후보를 모으려고 모든 서버를 본다 | `seed` |

동률이면 ID가 작은 서버를 고른다.

`power_of_four`와 `power_of_eight`는 `power_of_two`에 `choices=4`, `choices=8`을 준 것과 결정이 같다.
전략 파라미터는 한 실행의 모든 전략에 공통이므로, 후보 수를 이름으로 고정해 두면 `strategy=all`
한 번으로 d=2, 4, 8을 같은 결과 그룹에서 비교할 수 있다. 이 둘은 `choices`를 받지 않는다.

## 전략 추가하기

1. `src/strategies/<이름>.cpp`를 만들고 `Strategy`를 상속해 `selectServer()`를 구현한다.
   - `ClusterView`로 서버 수, 크기, 사용량, 남은 용량, 세션 수, 이용률을 조회한다.
   - 서버 구성에 맞춘 준비가 필요하면 `initialize()`를 재정의한다.
   - 무작위가 필요하면 `lb::Rng`와 `lb::uniform01()`을 쓰고 시드를 파라미터로 받는다.
2. `StrategyInfo`(이름, 설명, 파라미터 설명, 생성 함수)를 돌려주는 함수를 만들어
   `src/strategies/builtin.hpp`에 선언하고 `builtin.cpp`의 `makeBuiltinStrategies()`에 등록한다.
3. 테스트 `everyStrategyKeepsInvariants`가 등록된 모든 전략의 불변식(요청 수 일치, 용량 초과 없음,
   해제 후 사용량 0, 위반 없음)을 자동으로 검사한다.

```cpp
// src/strategies/most_remaining.cpp: 남은 용량이 가장 큰 서버
class MostRemainingStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        std::optional<ServerId> best;
        for (ServerId id = 0; id < cluster.serverCount(); ++id) {
            if (cluster.fits(id, request.weight) && (!best || cluster.remaining(id) > cluster.remaining(*best))) {
                best = id;
            }
        }
        return best;
    }
};

StrategyInfo mostRemainingStrategy() {
    return {"most_remaining", "남은 용량이 가장 큰 서버", {},
            [](const Params&) { return std::make_unique<MostRemainingStrategy>(); }};
}
```
