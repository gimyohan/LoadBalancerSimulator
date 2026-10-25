# 로드 밸런싱 분석 지표 조사 보고서

작성일: 2026-10-23

## 요약

현재 시뮬레이터는 수락·거절, 평균 이용률, 이용률 분산, 선택 시간만 내고, 현업이 핵심으로 보는 **균형 품질 지수**와 **거절 원인**은 다루지 않는다. 이 보고서는 현업 로드 밸런서와 관련 연구에서 쓰는 지표를 조사해 현재 출력과 비교하고, 추가할 지표를 우선순위별로 제안한다.

- **조사 범위:** 웹 로드 밸런서·프록시(AWS ELB, Envoy, HAProxy), SRE 운영 원칙, 균형 품질 연구(Maglev, Jain 지수 등), 명세의 다른 시나리오(기지국, 객체 스토리지)
- **가장 큰 공백:** 부하가 얼마나 고르게 나뉘었는지(최대/평균, 변동계수, Jain 지수)와 거절이 용량 부족 때문인지 전략 탓인지를 구분하는 지표
- **1순위 제안:** 지금 모델로 바로 계산할 수 있는 지표 5가지. 균형 지수, 단편화 거절, 거절의 시간·크기 분포, 서버별 포화도, 결정 비용 카운터다
- **2순위 이후:** 서버 장애, 대기열, 세션 이동처럼 이벤트 모델을 넓혀야 얻을 수 있는 지표

## 웹 로드 밸런서·프록시가 생산하는 지표

세 제품 모두 거절을 원인별로 나눠 세고, 서버별 동시성의 최댓값과 대기열을 따로 기록한다. [AWS ALB](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html), [AWS CLB](https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/elb-cloudwatch-metrics.html), [Envoy](https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats), [HAProxy](https://docs.haproxy.org/3.0/management.html) 문서에서 정리했다.

| 분류 | 실제 지표 | 의미 |
| --- | --- | --- |
| 처리량 | `RequestCount`, `RequestCountPerTarget`(AWS), `lbtot`, `rate`(HAProxy) | 전체·서버별 요청 수. `lbtot`는 서버가 선택된 총횟수 |
| 동시성 | `ActiveConnectionCount`(AWS), `scur`/`smax`/`slim`(HAProxy) | 서버별 현재·최대 세션 수와 설정된 한도 |
| 거절·과부하 | `RejectedConnectionCount`, `SpilloverCount`, `HTTPCode_ELB_503`(AWS), `upstream_rq_pending_overflow`, `upstream_cx_overflow`(Envoy) | 거절을 원인별로 셈: 밸런서 연결 한도, 대기열 넘침, 서킷 브레이커 |
| 대기열 | `SurgeQueueLength`(AWS), `qcur`/`qmax`/`qtime`(HAProxy) | 서버 배정을 기다리는 요청 수와 대기 시간. AWS는 최댓값을 보라고 권장 |
| 지연 | `TargetResponseTime`(AWS), `ctime`/`rtime`/`ttime`(HAProxy), `upstream_rq_time`(Envoy) | 응답 시간. AWS는 평균 대신 p99 같은 분위수를, Envoy는 히스토그램을 쓴다 |
| 서버 상태 | `HealthyHostCount`/`UnHealthyHostCount`(AWS), `membership_healthy`(Envoy), `status`/`downtime`(HAProxy) | 서버 장애·복구와 정상 서버 수 |
| 균형 예외 동작 | `lb_healthy_panic`, `outlier_detection.ejections_*`(Envoy), `wredis`(HAProxy) | 정상 서버가 너무 적어 전부에 분산한 횟수, 이상 서버 제외, 다른 서버로 재배정 |
| 세션 고정 | `NonStickyRequestCount`(AWS) | 기존 서버로 보낼 수 없어 새로 고른 횟수 |

## SRE 운영 원칙

[Google SRE Book](https://sre.google/sre-book/monitoring-distributed-systems/)은 사용자 대면 시스템을 네 가지 골든 시그널로 감시하고, 평균 대신 분포를 기록하라고 권한다.

- **지연(latency):** 요청 처리 시간. 실패한 요청의 지연도 따로 본다
- **트래픽(traffic):** 시스템에 맞는 단위의 수요. 예: 초당 요청 수
- **오류(errors):** 명시적 실패, 암묵적 실패, 정책상 실패
- **포화도(saturation):** 가장 부족한 자원이 얼마나 찼는지. 지연이 늘기 시작하면 곧 포화된다는 신호로 본다

평균이 정상이어도 일부 요청은 매우 느릴 수 있으므로, 히스토그램 구간이나 분위수로 기록해야 한다. 여러 백엔드를 거치는 요청에서는 느린 백엔드 하나의 꼬리가 사용자 경험을 좌우한다. 시뮬레이터에서는 서버 선택 시간에만 분위수가 있고, 이용률·거절은 평균과 누적값뿐이다.

## 균형 품질 지표

연구와 대규모 시스템은 분산 대신 규모에 영향받지 않는 지수로 균형을 평가하고, 서버가 바뀔 때의 혼란을 따로 잰다.

| 지표 | 정의 | 쓰임과 보고된 값 |
| --- | --- | --- |
| 과잉 확보 계수(overprovision factor) | 최대 부하 ÷ 평균 부하 | [Maglev](https://research.google/pubs/pub44824/): 가장 바쁜 서버도 감당해야 하므로 중요. 운영 환경에서 60% 이상의 시간 동안 1.2 미만 |
| 변동계수(CV) | 표준편차 ÷ 평균 | Maglev 운영 환경에서 6~7% |
| 해싱 균형 효율 | 조회 테이블 항목이 서버별로 고르게 나뉘는 정도 | 서버 1,000대·테이블 65,537칸에서 Karger 해싱은 29.7%, Rendezvous 해싱은 49.5%를 더 확보해야 했다 |
| 혼란(disruption) | 서버가 빠지거나 더해질 때 다시 배정되는 비율 | Maglev가 균형과 함께 보는 두 번째 축 |
| [Jain 공정성 지수](https://research.engineering.wustl.edu/~jain/atmf/ftp/af_fairn.pdf) | (Σx)² ÷ (n · Σx²), 0~1 | 모두 같으면 1, k개만 쓰이면 k/n. Jain은 분산이 단위에 따라 달라져 공정성 지표로 부적합하다고 지적 |
| 부하 상한 ≤ c · 평균 | 서버당 부하 상한을 두는 방식 | [Consistent Hashing with Bounded Loads](https://arxiv.org/pdf/1608.01350): Vimeo가 c=1.25로 적용해 캐시 대역폭을 약 8배 줄임 |
| 최대 부하 | 가장 많이 찬 서버의 부하 | [Power of two choices](https://www.eecs.harvard.edu/~michaelm/postscripts/cpc1999.pdf): 무작위 배정은 약 log n / log log n, 후보 2개 중 선택하면 약 log log n |

현재 시뮬레이터가 쓰는 이용률 분산은 부하 수준이 다른 실험끼리 값을 비교하기 어렵다. 위 지수들은 평균으로 나눠 정규화하므로 이 문제가 없다.

## 시나리오별 지표

명세가 예로 든 기지국과 객체 스토리지는 웹 로드 밸런서와 부하의 단위가 다르다.

**기지국 (셀 부하 분산)**

- **부하 지표:** PRB(무선 자원 블록) 이용률, RRC 연결 단말 수, 가용 용량을 기지국끼리 주고받는다. [NetSim의 5G 부하 분산 예제](https://support.tetcos.com/support/solutions/articles/14000138368-5g-load-balancing-algorithm-testing-using-netsim)도 이 값들을 입력으로 쓴다
- **수락 제어:** 받을 수 없는 연결은 거절한다. 시뮬레이터의 거절과 같은 개념이다
- **이동 KPI:** 핸드오버 실패율, 핸드오버로 인한 호 끊김율, 핸드오버 빈도, 핑퐁률(예: 5초 안에 원래 셀로 돌아가는 비율)을 본다 ([arXiv 1511.00797](https://arxiv.org/pdf/1511.00797)). 핑퐁을 줄이면 실패가 늘어나는 상충 관계가 있다 ([Aalto 실망 연구](https://aaltodoc.aalto.fi/items/ae16930e-4fca-4414-90ed-a733e4c1b343))

**객체 스토리지 (S3)**

- **한도:** [프리픽스(파티션)당 초당 3,500 쓰기, 5,500 읽기](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html). 프리픽스 수에는 제한이 없다
- **초과 시:** 확장하는 동안 503 SlowDown 오류가 난다
- **의미:** 동시 사용량보다 **파티션별 요청 도착률**과 특정 파티션에 몰리는 핫스팟이 문제가 된다. 현재 모델은 동시 가중치만 제한하므로 이 경우를 표현하지 못한다

## 현재 시뮬레이터와의 비교

11개 영역 중 충분한 것은 처리 결과 하나뿐이고, 균형 품질과 거절 원인이 가장 크게 비어 있다. 기준은 `lb_simulator`가 현재 쓰는 `summary`, `servers`, `timeline`, `assignments`, `violations` CSV다.

| 영역 | 현업 지표 | 현재 시뮬레이터 | 상태 |
| --- | --- | --- | --- |
| 처리 결과 | 요청·수락·거절 | `connects`, `accepted`, `rejected`, `violations` | 있음 |
| 거절 원인 | 원인별 분리(용량, 대기열, 서킷 브레이커) | 거절/위반 2가지 | 부족 |
| 거절 시간 분포 | 분 단위 시계열 | 누적값 스냅샷만 | 부족 |
| 균형 품질 | 최대/평균, 변동계수, Jain 지수 | 이용률 분산(규모에 따라 값이 변함) | 부족 |
| 포화도 | 최대 세션 수, 포화 시간 | 서버별 최대 이용률 | 부족 |
| 서버별 처리량 | `lbtot`, `RequestCountPerTarget` | `accepted_sessions` | 일부 |
| 분위수 | p50/p95/p99 | 선택 시간에만 있음 | 부족 |
| 선택 비용 | (프록시는 측정 안 함) | wall-clock, 시계 해상도 100ns | 측정이 거침 |
| 서버 장애·혼란 | 정상 서버 수, 재배정 비율 | 없음 | 모델 확장 필요 |
| 대기열·지연 | 대기열 길이, 대기 시간 | 없음(대기열 모델 없음) | 모델 확장 필요 |
| 세션 고정·이동 | 고정 실패, 핸드오버 | 없음 | 모델 확장 필요 |

## 개선 제안

1순위 5가지는 지금의 이벤트 모델에서 바로 계산할 수 있고, "어느 전략이 왜 더 나은가"를 설명할 근거를 가장 많이 늘린다.

### 1순위: 현재 모델로 계산 가능

1. **균형 지수 3종:** 최대/평균(과잉 확보 계수), 변동계수, Jain 지수를 시계열로 기록하고, summary에는 시간 평균과 p95·p99를 쓴다.
2. **단편화 거절:** 거절 시점에 클러스터 전체 남은 용량은 세션 가중치보다 컸는데도 거절된 건수. 용량이 진짜 부족한 거절과 전략이 자리를 쪼개 놓아 생긴 거절을 구분한다.
3. **거절의 시간·크기 분포:**
    - 구간별 거절 수와 거절률
    - 가중치로 따진 거절률: 거절된 가중치 ÷ 요청된 가중치
    - 가중치 구간별 거절률: 큰 세션이 더 자주 밀려나는지 확인
4. **서버별 포화도:**
    - 최대 동시 세션 수(HAProxy `smax`에 해당)
    - 이용률 90% 이상, 100%였던 시간
    - 트래픽 몫 대비 용량 몫: 크기가 다른 서버에 용량 비율만큼 트래픽이 갔는지
5. **결정 비용 카운터:** 결정마다 `ClusterView`를 몇 번 조회했는지(몇 개 서버를 살폈는지) 센다. 시계 해상도와 상관없이 정확하고 결정적이다. 예: power_of_two는 2회, least_load는 서버 수만큼.

### 2순위: 이벤트 모델 확장 필요

- **서버 장애·복구 이벤트:** 정상 서버 수, 끊긴 세션 수, 서버 변경 시 재배정 비율(Maglev의 혼란 지표). 해시 기반 전략을 추가한다면 필수다.
- **대기열:** 즉시 거절하지 않고 대기열에 넣는 모델. 대기열 길이, 대기 시간, 대기열이 차서 거절된 수(`SpilloverCount`에 해당).
- **세션 고정·재배치:** 고정 실패 수, 옮긴 세션 수, 핑퐁. 기지국 시나리오와 맞닿아 있다.

### 3순위: 시나리오 특화

- **서버별 연결 도착률 한도:** S3처럼 동시 사용량이 아니라 초당 요청 수에 한도가 있는 경우를 모델링한다.

## 출처

- [AWS: Application Load Balancer CloudWatch 지표](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html)
- [AWS: Classic Load Balancer CloudWatch 지표](https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/elb-cloudwatch-metrics.html)
- [Envoy: 클러스터 통계](https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats)
- [HAProxy 3.0 Management Guide (9.1 CSV 형식)](https://docs.haproxy.org/3.0/management.html)
- [Google SRE Book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Maglev: A Fast and Reliable Software Network Load Balancer (NSDI 2016)](https://research.google/pubs/pub44824/)
- [Jain: 공정성 지수](https://research.engineering.wustl.edu/~jain/atmf/ftp/af_fairn.pdf)
- [Consistent Hashing with Bounded Loads](https://arxiv.org/pdf/1608.01350)
- [Mitzenmacher: The Power of Two Choices](https://www.eecs.harvard.edu/~michaelm/postscripts/cpc1999.pdf)
- [AWS S3: 성능 최적화 모범 사례](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)
- [NetSim: 5G 부하 분산 알고리즘 시험](https://support.tetcos.com/support/solutions/articles/14000138368-5g-load-balancing-algorithm-testing-using-netsim)
- [Is It Possible to Simultaneously Achieve Zero Handover Failure Rate and Ping-Pong Rate? (arXiv 1511.00797)](https://arxiv.org/pdf/1511.00797)
- [Effectiveness of mobility robustness optimisation in a live LTE network (Aalto)](https://aaltodoc.aalto.fi/items/ae16930e-4fca-4414-90ed-a733e4c1b343)
