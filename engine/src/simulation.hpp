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
};

enum class Outcome { Accepted, Rejected, Violation };

// 연결 요청 하나의 처리 결과.
struct Assignment {
    SessionId session_id;
    Timestamp time;
    Weight weight;
    std::int64_t server;     // 할당된 서버. 거절이면 -1, 위반이면 전략이 고른 값
    Outcome outcome;
    std::int64_t select_ns;  // selectServer() 실제 실행 시간(wall-clock)
};

struct ViolationRecord {
    SessionId session_id;
    Timestamp time;
    Weight weight;
    std::int64_t chosen_server;
    Weight remaining;  // 고른 서버의 남은 용량. 범위를 벗어난 ID면 -1
    std::string reason;
};

// sample.time 시점(그 시각까지의 이벤트를 모두 반영한 뒤)의 상태.
struct Sample {
    Timestamp time;
    std::int64_t active_sessions;
    Weight total_load;
    double utilization_mean;      // 서버 이용률(load / capacity)의 평균
    double utilization_variance;  // 서버 이용률의 서버 간 분산
    std::int64_t accepted;        // 누적
    std::int64_t rejected;        // 누적 (전략 거절)
    std::int64_t violations;      // 누적
    std::vector<Weight> loads;    // 서버별 사용량
};

struct ServerStats {
    Weight capacity;
    std::int64_t accepted_sessions;
    Weight peak_load;
    double mean_load;  // [start_time, end_time] 시간 가중 평균
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

struct SimulationResult {
    std::int64_t connects = 0;
    std::int64_t accepted = 0;
    std::int64_t rejected = 0;    // 전략이 거절한 요청
    std::int64_t violations = 0;  // 전략의 잘못된 선택 (거절로 처리됨)
    Timestamp start_time = 0;     // 첫 이벤트 시각
    Timestamp end_time = 0;       // 마지막 이벤트 시각

    // 시간 가중 평균. 이벤트 사이에는 상태가 일정하므로 구간 길이로 가중해 정확히 적분한다.
    double utilization_mean = 0;           // 서버 평균 이용률
    double utilization_variance_mean = 0;  // 서버 간 이용률 분산 (순간 불균형의 평균)
    double server_utilization_variance = 0;  // 서버별 평균 이용률의 분산 (장기 불균형)
    Weight peak_total_load = 0;

    TimingStats timing;
    std::vector<ServerStats> servers;
    std::vector<Sample> timeline;
    std::vector<Assignment> assignments;
    std::vector<ViolationRecord> violation_log;

    std::int64_t rejectedTotal() const { return rejected + violations; }
    double rejectionRate() const {
        return connects ? static_cast<double>(rejectedTotal()) / static_cast<double>(connects) : 0.0;
    }
};

// events는 시각 순으로 정렬되고 제약 조건을 만족해야 한다 (lb::validateEvents).
// capacities는 서버별 크기(1 이상)이며, 서버 ID는 그 순서대로 0부터 매긴다.
SimulationResult runSimulation(const std::vector<Event>& events, const std::vector<Weight>& capacities,
                               Strategy& strategy, const SimulationOptions& options = {});

std::string_view toString(Outcome outcome);

}  // namespace lb::sim
