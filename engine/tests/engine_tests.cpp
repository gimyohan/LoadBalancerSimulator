#include <algorithm>
#include <cmath>
#include <functional>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "lb/console.hpp"
#include "lb/event.hpp"
#include "lb/params.hpp"
#include "server_spec.hpp"
#include "simulation.hpp"
#include "strategies/builtin.hpp"

namespace {

using namespace lb;
using namespace lb::sim;

int g_failures = 0;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        if (!(cond)) {                                                                 \
            ++g_failures;                                                              \
            std::cerr << "  실패: " << __FILE__ << ':' << __LINE__ << ": " #cond "\n"; \
        }                                                                              \
    } while (0)

bool near(double a, double b) { return std::abs(a - b) < 1e-9; }

template <typename Fn>
bool throws(Fn&& fn) {
    try {
        fn();
    } catch (const std::exception&) {
        return true;
    }
    return false;
}

struct SessionSpan {
    Timestamp connect;
    Timestamp disconnect;
    Weight weight;
};

// 세션 목록으로 시각 순 이벤트를 만든다. 세션 ID는 1부터.
std::vector<Event> makeEvents(const std::vector<SessionSpan>& sessions) {
    std::vector<Event> events;
    for (std::size_t i = 0; i < sessions.size(); ++i) {
        const auto id = static_cast<SessionId>(i + 1);
        events.push_back({id, EventType::Connect, sessions[i].connect, sessions[i].weight});
        events.push_back({id, EventType::Disconnect, sessions[i].disconnect, sessions[i].weight});
    }
    std::stable_sort(events.begin(), events.end(),
                     [](const Event& a, const Event& b) { return a.timestamp < b.timestamp; });
    return events;
}

// 겹치는 세션이 많은 결정적 데이터셋. 가중치 1~4.
std::vector<Event> busyEvents() {
    std::vector<SessionSpan> sessions;
    for (Timestamp i = 0; i < 400; ++i) sessions.push_back({i * 10, i * 10 + 1005 + (i % 7) * 113, 1 + i % 4});
    return makeEvents(sessions);
}

std::unique_ptr<Strategy> create(const std::string& name, const Params& params = {}) {
    const StrategyRegistry registry = makeBuiltinStrategies();
    return registry.find(name)->create(params);
}

std::int64_t pickFirst(const std::string& strategy, const std::vector<Weight>& capacities,
                       const std::vector<SessionSpan>& preload, Weight weight) {
    // preload 세션을 서버에 채운 뒤 마지막 연결 하나가 어디로 가는지 본다.
    std::vector<SessionSpan> sessions = preload;
    sessions.push_back({1000, 2000, weight});
    auto s = create(strategy);
    const SimulationResult r = runSimulation(makeEvents(sessions), capacities, *s);
    return r.assignments.back().server;
}

// 정해진 서버 ID를 그대로 돌려주는 테스트용 전략.
class FixedStrategy final : public Strategy {
public:
    explicit FixedStrategy(std::optional<ServerId> choice) : choice_(choice) {}
    std::optional<ServerId> selectServer(const ConnectRequest&, const ClusterView&) override { return choice_; }

private:
    std::optional<ServerId> choice_;
};

void serverSpecParsing() {
    CHECK(parseServerSpec("3x10") == (std::vector<Weight>{10, 10, 10}));
    CHECK(parseServerSpec("5, 7") == (std::vector<Weight>{5, 7}));
    CHECK(parseServerSpec("2x1,1x4") == (std::vector<Weight>{1, 1, 4}));
    CHECK(throws([] { parseServerSpec("0x10"); }));
    CHECK(throws([] { parseServerSpec("2x0"); }));
    CHECK(throws([] { parseServerSpec("ten"); }));
    CHECK(throws([] { parseServerSpec(""); }));
}

void everyStrategyKeepsInvariants() {
    const auto events = busyEvents();
    const std::vector<Weight> capacities{20, 20, 40};
    const StrategyRegistry registry = makeBuiltinStrategies();
    for (const StrategyInfo& info : registry.all()) {
        auto strategy = info.create(Params{});
        const SimulationResult r = runSimulation(events, capacities, *strategy);
        CHECK(r.connects == 400);
        CHECK(r.accepted + r.rejected + r.violations == r.connects);
        CHECK(static_cast<std::int64_t>(r.assignments.size()) == r.connects);
        CHECK(r.timeline.back().time == r.end_time);
        CHECK(r.timeline.back().total_load == 0);  // 모든 세션이 해제됐다
        for (const Sample& s : r.timeline) {
            for (std::size_t id = 0; id < capacities.size(); ++id) CHECK(s.loads[id] <= capacities[id]);
        }
        for (std::size_t id = 0; id < capacities.size(); ++id) CHECK(r.servers[id].peak_load <= capacities[id]);
        if (info.name != "blind_round_robin") CHECK(r.violations == 0);
        if (r.rejected + r.violations == 0) std::cerr << "    " << info.name << ": 거절 없음 (부하가 너무 낮다)\n";
    }
}

void rejectsWhenFullAndReusesFreedCapacity() {
    // 크기 2인 서버 하나. 세 번째 세션은 들어갈 곳이 없고, 첫 세션이 나간 뒤 네 번째는 들어간다.
    const auto events = makeEvents({{0, 100, 1}, {10, 200, 1}, {20, 30, 1}, {150, 300, 1}});
    auto strategy = create("round_robin");
    const SimulationResult r = runSimulation(events, {2}, *strategy);
    CHECK(r.accepted == 3);
    CHECK(r.rejected == 1);
    CHECK(r.assignments[2].outcome == Outcome::Rejected);
    CHECK(r.assignments[3].outcome == Outcome::Accepted);
    CHECK(near(r.rejectionRate(), 0.25));
}

void detectsViolations() {
    // 용량을 무시하는 전략: 크기 1인 서버에 가중치 1 세션 둘이 겹친다.
    const auto events = makeEvents({{0, 100, 1}, {10, 50, 1}});
    auto blind = create("blind_round_robin");
    const SimulationResult r = runSimulation(events, {1}, *blind);
    CHECK(r.accepted == 1);
    CHECK(r.violations == 1);
    CHECK(r.violation_log.size() == 1);
    CHECK(r.violation_log[0].session_id == 2);
    CHECK(r.violation_log[0].remaining == 0);
    CHECK(r.timeline.back().total_load == 0);  // 위반 세션의 해제는 무시된다

    FixedStrategy missing(5);
    const SimulationResult m = runSimulation(events, {10, 10}, missing);
    CHECK(m.violations == 2);
    CHECK(m.violation_log[0].remaining == -1);
    CHECK(m.violation_log[0].chosen_server == 5);
}

void strategiesPickExpectedServers() {
    // 서버 0에 가중치 3, 서버 1에 가중치 1이 있는 상태에서 가중치 1 요청.
    const std::vector<SessionSpan> preload{{0, 5000, 3}, {1, 5000, 1}};
    CHECK(pickFirst("first_fit", {10, 10, 10}, preload, 1) == 0);
    CHECK(pickFirst("best_fit", {10, 10, 10}, preload, 1) == 0);           // 남는 용량 6이 최소
    CHECK(pickFirst("least_connections", {10, 10, 10}, preload, 1) == 2);  // 빈 서버
    // 크기가 다르면 이용률로 비교한다: 0: 3/10, 1: 1/2 → 서버 0
    CHECK(pickFirst("least_load", {10, 2}, preload, 1) == 0);
    CHECK(pickFirst("best_fit", {10, 2}, preload, 1) == 1);  // 남는 용량 0
    // 가중치 7은 서버 0(남은 7)에만 들어간다
    CHECK(pickFirst("least_connections", {10, 10}, preload, 7) == 0);
}

void timeWeightedUtilization() {
    // 서버 둘(크기 10), 가중치 5 세션이 0~100ms 동안 서버 0에만 있다.
    const auto events = makeEvents({{0, 100, 5}});
    auto strategy = create("first_fit");
    const SimulationResult r = runSimulation(events, {10, 10}, *strategy);
    CHECK(near(r.utilization_mean, 0.25));             // (0.5 + 0) / 2
    CHECK(near(r.utilization_variance_mean, 0.0625));  // (0.25 + 0)/2 - 0.25^2
    CHECK(near(r.servers[0].mean_load, 5.0));
    CHECK(near(r.servers[1].mean_load, 0.0));
    CHECK(near(r.server_utilization_variance, 0.0625));
    CHECK(r.peak_total_load == 5);
}

void samplingReflectsEventsAtSampleTime() {
    const auto events = makeEvents({{0, 100, 2}, {50, 150, 3}});
    auto strategy = create("first_fit");
    const SimulationResult r = runSimulation(events, {10}, *strategy, {50, 1000});
    // 샘플 시각: 0, 50, 100, 150
    CHECK(r.timeline.size() == 4);
    CHECK(r.timeline[0].total_load == 2);
    CHECK(r.timeline[1].total_load == 5);
    CHECK(r.timeline[2].total_load == 3);
    CHECK(r.timeline[3].total_load == 0);
    CHECK(r.timeline[1].accepted == 2);
}

void timingIsRecorded() {
    auto strategy = create("least_load");
    const SimulationResult r = runSimulation(busyEvents(), {20, 20, 40}, *strategy);
    CHECK(r.timing.min_ns >= 0);
    CHECK(r.timing.min_ns <= r.timing.p50_ns && r.timing.p50_ns <= r.timing.p99_ns);
    CHECK(r.timing.p99_ns <= r.timing.max_ns);
    CHECK(r.timing.total_ns >= r.timing.max_ns);
}

void seededStrategiesAreReproducible() {
    for (const std::string name : {"random", "power_of_two"}) {
        Params params;
        params.set("seed", "7");
        auto a = create(name, params);
        auto b = create(name, params);
        const auto ra = runSimulation(busyEvents(), {20, 20, 40}, *a);
        const auto rb = runSimulation(busyEvents(), {20, 20, 40}, *b);
        bool same = ra.assignments.size() == rb.assignments.size();
        for (std::size_t i = 0; same && i < ra.assignments.size(); ++i) {
            same = ra.assignments[i].server == rb.assignments[i].server;
        }
        CHECK(same);
    }
}

void rejectsBadInput() {
    auto strategy = create("first_fit");
    CHECK(throws([&] { runSimulation({}, {}, *strategy); }));
    CHECK(throws([&] { runSimulation({}, {0}, *strategy); }));
    std::vector<Event> unsorted{{1, EventType::Connect, 10, 1}, {1, EventType::Disconnect, 5, 1}};
    CHECK(throws([&] { runSimulation(unsorted, {1}, *strategy); }));
    Params bad;
    bad.set("choices", "0");
    CHECK(throws([&] { create("power_of_two", bad); }));
    CHECK(throws([&] { runSimulation(busyEvents(), {10}, *strategy, {0, 1000, 0.0}); }));
}

void balanceIndexes() {
    // 서버 둘(크기 10), 가중치 5 세션이 서버 0에만 있다: u = (0.5, 0)
    auto strategy = create("first_fit");
    const SimulationResult r = runSimulation(makeEvents({{0, 100, 5}}), {10, 10}, *strategy, {50, 1000, 0.9});
    CHECK(near(r.imbalance.mean, 2.0));  // 0.5 / 0.25
    CHECK(near(r.cv.mean, 1.0));         // 0.25 / 0.25
    CHECK(near(r.jain.mean, 0.5));       // 0.5² / (2 · 0.25)
    CHECK(near(r.imbalance.p99, 2.0));
    CHECK(near(r.timeline[1].balance.imbalance, 2.0));  // t=50
    CHECK(near(r.timeline.back().balance.jain, 1.0));   // 부하가 없으면 완전 균형으로 본다

    // 고르게 나누면 완전 균형. 단 처음 1ms(부하 5)는 한 서버에만 있고, 이후 99ms(부하 10)는 고르다.
    // 부하 × 시간 가중: imbalance = (2·5 + 1·990) / 995, jain = (0.5·5 + 1·990) / 995
    auto rr = create("round_robin");
    const SimulationResult even = runSimulation(makeEvents({{0, 100, 5}, {1, 100, 5}}), {10, 10}, *rr);
    CHECK(near(even.imbalance.mean, 1000.0 / 995.0));
    CHECK(near(even.jain.mean, 992.5 / 995.0));
    CHECK(near(even.imbalance.p95, 1.0));  // 가중치의 99.5%가 균형 구간이다
}

void rejectReasons() {
    // 용량 부족: 크기 2 서버 하나에 세 세션이 겹친다
    auto first = create("first_fit");
    const SimulationResult capacity = runSimulation(makeEvents({{0, 100, 1}, {1, 100, 1}, {2, 100, 1}}), {2}, *first);
    CHECK(capacity.rejected_capacity == 1);
    CHECK(capacity.assignments[2].reject_reason == RejectReason::Capacity);

    // 단편화: 라운드 로빈이 크기 2 서버 둘에 하나씩 넣으면 전체 남은 2로도 가중치 2를 못 받는다
    auto rr = create("round_robin");
    const SimulationResult fragmented =
        runSimulation(makeEvents({{0, 100, 1}, {1, 100, 1}, {2, 100, 2}}), {2, 2}, *rr);
    CHECK(fragmented.rejected_fragmentation == 1);
    CHECK(fragmented.rejected_capacity == 0);
    CHECK(fragmented.requested_weight == 4);
    CHECK(fragmented.rejected_weight == 2);
    CHECK(near(fragmented.weightedRejectionRate(), 0.5));
    CHECK(fragmented.weight_classes.size() == 2);
    CHECK(fragmented.weight_classes[0].weight_min == 1 && fragmented.weight_classes[0].requests == 2);
    CHECK(fragmented.weight_classes[1].weight_min == 2 && fragmented.weight_classes[1].weight_max == 3);
    CHECK(fragmented.weight_classes[1].rejected == 1);

    // 회피 가능: 빈 서버가 있는데 전략이 거절한다
    FixedStrategy refuse(std::nullopt);
    const SimulationResult avoidable = runSimulation(makeEvents({{0, 100, 1}}), {5}, refuse);
    CHECK(avoidable.rejected_avoidable == 1);
    CHECK(avoidable.assignments[0].reject_reason == RejectReason::Avoidable);
}

void serverSaturation() {
    // 크기 2 서버 하나: 0~100ms 꽉 참(이용률 1), 150~200ms 이용률 0.5
    auto strategy = create("first_fit");
    const SimulationResult r = runSimulation(makeEvents({{0, 100, 2}, {150, 200, 1}}), {2}, *strategy);
    CHECK(r.servers[0].full_time == 100);
    CHECK(r.servers[0].hot_time == 100);
    CHECK(near(r.full_time_fraction, 0.5));
    CHECK(r.servers[0].peak_sessions == 1);
    CHECK(r.servers[0].accepted_weight == 3);

    // 크기가 다른 서버: 몫은 각각 합이 1
    auto least = create("least_load");
    const SimulationResult shares = runSimulation(busyEvents(), {20, 20, 40}, *least);
    double load_sum = 0, capacity_sum = 0;
    for (const ServerStats& s : shares.servers) {
        load_sum += s.load_share;
        capacity_sum += s.capacity_share;
    }
    CHECK(near(load_sum, 1.0));
    CHECK(near(capacity_sum, 1.0));
    CHECK(near(shares.servers[2].capacity_share, 0.5));
}

void decisionCost() {
    const auto events = makeEvents({{0, 100, 1}});
    auto first = create("first_fit");  // 빈 서버 0에서 멈춘다
    CHECK(runSimulation(events, {5, 5, 5, 5}, *first).assignments[0].servers_inspected == 1);
    auto least = create("least_load");  // 모든 서버를 본다
    const SimulationResult all = runSimulation(events, {5, 5, 5, 5}, *least);
    CHECK(all.assignments[0].servers_inspected == 4);
    CHECK(all.assignments[0].queries >= 4);
    CHECK(near(all.servers_inspected.mean, 4.0));
    auto p2c = create("power_of_two");  // 후보 2개만 본다
    const SimulationResult sampled = runSimulation(busyEvents(), {20, 20, 20, 20, 20, 20}, *p2c);
    CHECK(sampled.servers_inspected.max <= 2);
    // 엔진의 위반 확인이나 거절 원인 판정은 전략의 조회 수에 들어가지 않는다
    FixedStrategy refuse(std::nullopt);
    CHECK(runSimulation(events, {5, 5}, refuse).assignments[0].queries == 0);
}

void powerOfChoicesVariants() {
    const std::vector<Weight> capacities{20, 20, 20, 20, 20, 20};
    const auto events = busyEvents();

    // power_of_four와 power_of_eight는 이름의 수만큼만 후보를 본다.
    // choices를 받지 않으므로 넘기면 쓰지 않은 키로 남는다.
    Params params;
    params.set("choices", "2");
    auto four = create("power_of_four", params);
    CHECK(params.unusedKeys() == std::vector<std::string>{"choices"});
    const SimulationResult r4 = runSimulation(events, capacities, *four);
    CHECK(r4.servers_inspected.max <= 4);
    Params params8;
    params8.set("choices", "2");
    auto eight = create("power_of_eight", params8);
    CHECK(params8.unusedKeys() == std::vector<std::string>{"choices"});
    const SimulationResult r8 = runSimulation(events, capacities, *eight);
    CHECK(r8.servers_inspected.max <= 6);  // 후보 8개는 중복을 허용하므로 서버 6대를 넘지 않는다
    auto two = create("power_of_two");
    const SimulationResult r2 = runSimulation(events, capacities, *two);
    // 후보가 많을수록 놓치는 자리가 적다
    CHECK(r4.rejected_avoidable <= r2.rejected_avoidable);
    CHECK(r8.rejected_avoidable <= r4.rejected_avoidable);

    // 이름으로 고정한 power_of_n은 power_of_two에 choices를 준 것과 같은 결정을 내린다.
    Params choices8;
    choices8.set("choices", "8");
    auto two8 = create("power_of_two", choices8);
    const SimulationResult r2x8 = runSimulation(events, capacities, *two8);
    CHECK(r2x8.assignments.size() == r8.assignments.size());
    for (std::size_t i = 0; i < r8.assignments.size(); ++i) {
        CHECK(r2x8.assignments[i].server == r8.assignments[i].server);
    }

    // feasible_power_of_two는 들어갈 서버가 있으면 거절하지 않고, 후보를 모으려고 모든 서버를 본다.
    auto feasible = create("feasible_power_of_two");
    const SimulationResult rf = runSimulation(events, capacities, *feasible);
    CHECK(rf.rejected_avoidable == 0);
    CHECK(rf.violations == 0);
    CHECK(near(rf.servers_inspected.mean, 6.0));

    // 들어갈 서버가 하나뿐이면 그 서버를 고른다: 크기 2, 9 서버에 가중치 5 세션
    auto pick = create("feasible_power_of_two");
    const SimulationResult single = runSimulation(makeEvents({{0, 100, 5}}), {2, 9}, *pick);
    CHECK(single.assignments[0].outcome == Outcome::Accepted && single.assignments[0].server == 1);
    // 들어갈 서버가 없으면 거절하고, 그 원인은 클러스터 상태로 정해진다
    const SimulationResult none = runSimulation(makeEvents({{0, 100, 5}}), {2, 4}, *pick);
    CHECK(none.rejected_fragmentation == 1);
}

}  // namespace

int main() {
    lb::enableUtf8Console();
    const std::pair<const char*, std::function<void()>> tests[] = {
        {"serverSpecParsing", serverSpecParsing},
        {"everyStrategyKeepsInvariants", everyStrategyKeepsInvariants},
        {"rejectsWhenFullAndReusesFreedCapacity", rejectsWhenFullAndReusesFreedCapacity},
        {"detectsViolations", detectsViolations},
        {"strategiesPickExpectedServers", strategiesPickExpectedServers},
        {"timeWeightedUtilization", timeWeightedUtilization},
        {"samplingReflectsEventsAtSampleTime", samplingReflectsEventsAtSampleTime},
        {"timingIsRecorded", timingIsRecorded},
        {"seededStrategiesAreReproducible", seededStrategiesAreReproducible},
        {"rejectsBadInput", rejectsBadInput},
        {"balanceIndexes", balanceIndexes},
        {"rejectReasons", rejectReasons},
        {"serverSaturation", serverSaturation},
        {"decisionCost", decisionCost},
        {"powerOfChoicesVariants", powerOfChoicesVariants},
    };
    for (const auto& [name, test] : tests) {
        const int before = g_failures;
        try {
            test();
        } catch (const std::exception& e) {
            ++g_failures;
            std::cerr << "  예외: " << e.what() << '\n';
        }
        std::cout << (g_failures == before ? "[ OK ] " : "[FAIL] ") << name << '\n';
    }
    std::cout << (g_failures ? "실패 " + std::to_string(g_failures) + "건\n" : "모두 통과\n");
    return g_failures ? 1 : 0;
}
