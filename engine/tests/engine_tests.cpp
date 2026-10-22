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
