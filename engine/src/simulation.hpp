#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "lb/event.hpp"
#include "strategy.hpp"

namespace lb::sim {

struct SimulationOptions {
    Timestamp sample_interval = 0;   // 사용량 스냅샷 간격(ms). 0이면 target_samples로 자동
    std::int64_t target_samples = 1000;
    double hot_threshold = 0.9;      // 이 이용률 이상이면 '포화에 가까운' 서버로 센다
};

enum class Outcome { Accepted, Rejected, Violation };

// 전략이 거절한 요청을 클러스터 상태로 나눈 원인.
enum class RejectReason {
    None,           // 거절이 아니다
    Capacity,       // 전체 남은 용량이 세션 가중치보다 작다: 어떤 전략도 받을 수 없었다
    Fragmentation,  // 전체 남은 용량은 충분하지만 들어갈 서버가 없다: 세션을 옮겼다면 받을 수 있었다
    Avoidable,      // 들어갈 서버가 있었는데 전략이 거절했다
};

// 연결 요청 하나의 처리 결과.
struct Assignment {
    SessionId session_id;
    Timestamp time;
    Weight weight;
    std::int64_t server;     // 할당된 서버. 거절이면 -1, 위반이면 전략이 고른 값
    Outcome outcome;
    RejectReason reject_reason;
    std::int64_t select_ns;  // selectServer() 실제 실행 시간(wall-clock)
    std::int64_t queries;    // 결정 동안 ClusterView 서버 조회 수
    std::int64_t servers_inspected;  // 결정 동안 살펴본 서로 다른 서버 수
};

struct ViolationRecord {
    SessionId session_id;
    Timestamp time;
    Weight weight;
    std::int64_t chosen_server;
    Weight remaining;  // 고른 서버의 남은 용량. 범위를 벗어난 ID면 -1
    std::string reason;
};

// 서버 이용률 u_i(= load / capacity)의 균형 지수. 부하가 전혀 없으면 완전 균형(1, 0, 1)으로 본다.
struct BalanceIndex {
    double imbalance = 1.0;  // max(u) / mean(u): 과잉 확보 계수(Maglev). 1이 완전 균형
    double cv = 0.0;         // std(u) / mean(u): 변동계수. 0이 완전 균형
    double jain = 1.0;       // (Σu)² / (n·Σu²): Jain 공정성 지수. 1이 완전 균형, 1/n이 한 서버에 몰림
};

// sample.time 시점(그 시각까지의 이벤트를 모두 반영한 뒤)의 상태.
struct Sample {
    Timestamp time;
    std::int64_t active_sessions;
    Weight total_load;
    double utilization_mean;      // 서버 이용률(load / capacity)의 평균
    double utilization_variance;  // 서버 이용률의 서버 간 분산
    BalanceIndex balance;
    std::int64_t connects;        // 누적
    std::int64_t accepted;        // 누적
    std::int64_t rejected;        // 누적 (전략 거절)
    std::int64_t violations;      // 누적
    std::vector<Weight> loads;    // 서버별 사용량
};

struct ServerStats {
    Weight capacity;
    std::int64_t accepted_sessions;
    Weight accepted_weight;   // 수락한 세션 가중치 합
    Weight peak_load;
    std::int64_t peak_sessions;  // 최대 동시 세션 수
    double mean_load;         // [start_time, end_time] 시간 가중 평균
    Timestamp hot_time;       // 이용률이 hot_threshold 이상이었던 시간(ms)
    Timestamp full_time;      // 남은 용량이 0이었던 시간(ms)
    double load_share;        // 이 서버가 맡은 사용량-시간의 비율 (서버 합 = 1)
    double capacity_share;    // 이 서버 크기의 비율 (서버 합 = 1)
};

struct TimingStats {
    double mean_ns = 0;
    std::int64_t min_ns = 0;
    std::int64_t max_ns = 0;
    std::int64_t p50_ns = 0;
    std::int64_t p95_ns = 0;
    std::int64_t p99_ns = 0;
    std::int64_t total_ns = 0;
    // 측정 환경. 쿼리별 값은 resolution_ns 단위로 양자화되고 overhead_ns만큼의 시계 호출 비용을 포함한다.
    std::int64_t resolution_ns = 0;  // 시계가 구분하는 최소 간격
    double overhead_ns = 0;          // 빈 구간을 쟀을 때의 평균값
};

// 정수 개수(조회 수 등)의 분포 요약.
struct CountStats {
    double mean = 0;
    std::int64_t p50 = 0;
    std::int64_t p99 = 0;
    std::int64_t max = 0;
    std::int64_t total = 0;
};

// 부하 가중 분포 요약. 각 순간을 '그 순간의 총 사용량 × 지속 시간'으로 가중하므로
// 세션이 거의 없는 한산한 구간보다 부하가 실린 구간이 결과를 좌우한다.
struct WeightedStats {
    double mean = 0;
    double p01 = 0;
    double p05 = 0;
    double p95 = 0;
    double p99 = 0;
};

// 가중치 구간 [weight_min, weight_max]별 처리 결과. 구간은 2의 거듭제곱(1, 2–3, 4–7, ...)이다.
struct WeightClassStats {
    Weight weight_min;
    Weight weight_max;
    std::int64_t requests = 0;
    std::int64_t accepted = 0;
    std::int64_t rejected = 0;
    std::int64_t violations = 0;
    Weight requested_weight = 0;
    Weight rejected_weight = 0;  // 거절 + 위반
};

struct SimulationResult {
    std::int64_t connects = 0;
    std::int64_t accepted = 0;
    std::int64_t rejected = 0;    // 전략이 거절한 요청
    std::int64_t violations = 0;  // 전략의 잘못된 선택 (거절로 처리됨)
    std::int64_t rejected_capacity = 0;       // rejected 중 RejectReason::Capacity
    std::int64_t rejected_fragmentation = 0;  // rejected 중 RejectReason::Fragmentation
    std::int64_t rejected_avoidable = 0;      // rejected 중 RejectReason::Avoidable
    Weight requested_weight = 0;
    Weight rejected_weight = 0;   // 거절 + 위반된 요청의 가중치 합
    Timestamp start_time = 0;     // 첫 이벤트 시각
    Timestamp end_time = 0;       // 마지막 이벤트 시각

    // 시간 가중 평균. 이벤트 사이에는 상태가 일정하므로 구간 길이로 가중해 정확히 적분한다.
    double utilization_mean = 0;           // 서버 평균 이용률
    double utilization_variance_mean = 0;  // 서버 간 이용률 분산 (순간 불균형의 평균)
    double server_utilization_variance = 0;  // 서버별 평균 이용률의 분산 (장기 불균형)
    Weight peak_total_load = 0;

    // 균형 지수의 부하 가중 분포
    WeightedStats imbalance;
    WeightedStats cv;
    WeightedStats jain;

    double hot_threshold = 0;
    double hot_time_fraction = 0;   // 서버들이 hot_threshold 이상이었던 시간 비율 (서버 × 시간 평균)
    double full_time_fraction = 0;  // 서버들이 꽉 차 있던 시간 비율

    TimingStats timing;
    CountStats queries;            // 결정당 ClusterView 조회 수
    CountStats servers_inspected;  // 결정당 살펴본 서버 수
    std::vector<ServerStats> servers;
    std::vector<Sample> timeline;
    std::vector<Assignment> assignments;
    std::vector<ViolationRecord> violation_log;
    std::vector<WeightClassStats> weight_classes;  // 가중치 오름차순

    std::int64_t rejectedTotal() const { return rejected + violations; }
    double rejectionRate() const {
        return connects ? static_cast<double>(rejectedTotal()) / static_cast<double>(connects) : 0.0;
    }
    double weightedRejectionRate() const {
        return requested_weight ? static_cast<double>(rejected_weight) / static_cast<double>(requested_weight) : 0.0;
    }
};

// events는 시각 순으로 정렬되고 제약 조건을 만족해야 한다 (lb::validateEvents).
// capacities는 서버별 크기(1 이상)이며, 서버 ID는 그 순서대로 0부터 매긴다.
SimulationResult runSimulation(const std::vector<Event>& events, const std::vector<Weight>& capacities,
                               Strategy& strategy, const SimulationOptions& options = {});

std::string_view toString(Outcome outcome);
std::string_view toString(RejectReason reason);  // None이면 빈 문자열

}  // namespace lb::sim
