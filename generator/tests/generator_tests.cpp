#include <algorithm>
#include <functional>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "distribution.hpp"
#include "event_builder.hpp"
#include "lb/console.hpp"
#include "lb/event.hpp"
#include "lb/params.hpp"
#include "scenarios/builtin.hpp"

namespace {

using namespace lb;
using namespace lb::gen;

int g_failures = 0;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        if (!(cond)) {                                                                 \
            ++g_failures;                                                              \
            std::cerr << "  실패: " << __FILE__ << ':' << __LINE__ << ": " #cond "\n"; \
        }                                                                              \
    } while (0)

template <typename Fn>
bool throws(Fn&& fn) {
    try {
        fn();
    } catch (const std::exception&) {
        return true;
    }
    return false;
}

std::vector<Event> generate(const std::string& name, const Params& params, std::int64_t sessions,
                            double horizon, std::uint64_t seed) {
    const ScenarioRegistry registry = makeBuiltinRegistry();
    auto scenario = registry.find(name)->create(params);
    Rng rng(seed);
    return buildEvents(scenario->generate({sessions, horizon}, rng));
}

std::string toCsv(const std::vector<Event>& events) {
    std::ostringstream out;
    writeEventsCsv(out, events);
    return out.str();
}

void everyScenarioSatisfiesConstraints() {
    const ScenarioRegistry registry = makeBuiltinRegistry();
    for (const ScenarioInfo& info : registry.all()) {
        const auto events = generate(info.name, Params{}, 5000, 600.0, 7);
        const auto errors = validateEvents(events);
        CHECK(events.size() == 10000);
        CHECK(errors.empty());
        if (!errors.empty()) std::cerr << "    " << info.name << ": " << errors.front() << '\n';
        CHECK(std::is_sorted(events.begin(), events.end(),
                             [](const Event& a, const Event& b) { return a.timestamp < b.timestamp; }));
    }
}

void sameSeedIsReproducible() {
    const ScenarioRegistry registry = makeBuiltinRegistry();
    for (const ScenarioInfo& info : registry.all()) {
        CHECK(toCsv(generate(info.name, Params{}, 1000, 600.0, 42)) ==
              toCsv(generate(info.name, Params{}, 1000, 600.0, 42)));
        CHECK(toCsv(generate(info.name, Params{}, 1000, 600.0, 42)) !=
              toCsv(generate(info.name, Params{}, 1000, 600.0, 43)));
    }
}

void collidingTimesStayUnique() {
    // 모든 세션이 같은 시각에 들어와 즉시 나가는 극단적인 경우.
    std::vector<SessionSpec> sessions(500, SessionSpec{1.0, 0.0, 3});
    const auto events = buildEvents(sessions);
    CHECK(events.size() == 1000);
    CHECK(validateEvents(events).empty());
}

void csvRoundTrip() {
    const auto events = generate("mixed", Params{}, 300, 60.0, 1);
    std::istringstream in(toCsv(events));
    CHECK(readEventsCsv(in) == events);

    std::istringstream bad("session_id,type,timestamp,weight\n1,join,5,1\n");
    CHECK(throws([&] { readEventsCsv(bad); }));
}

void validatorCatchesViolations() {
    CHECK(!validateEvents({{1, EventType::Connect, 10, 1}}).empty());  // 해제 없음
    CHECK(!validateEvents({{1, EventType::Connect, 10, 1}, {1, EventType::Disconnect, 5, 1}}).empty());
    CHECK(!validateEvents({{1, EventType::Connect, 10, 1},
                           {1, EventType::Disconnect, 20, 1},
                           {2, EventType::Connect, 20, 1},
                           {2, EventType::Disconnect, 30, 1}})
               .empty());  // 같은 시각
}

void peakConcentratesArrivals() {
    Params params;
    params.set("peak_center", "0.5");
    params.set("peak_ratio", "10");
    const auto events = generate("peak", params, 20000, 1000.0, 3);
    int middle = 0, edge = 0;
    for (const Event& e : events) {
        if (e.type != EventType::Connect) continue;
        const double x = static_cast<double>(e.timestamp) / (1000.0 * kTicksPerSecond);
        if (x >= 0.4 && x < 0.6) ++middle;
        if (x < 0.2) ++edge;
    }
    CHECK(middle > 3 * edge);
}

void burstAtFixedPositions() {
    Params params;
    params.set("burst_at", "0.5");
    params.set("burst_length", "0.05");
    params.set("burst_ratio", "50");
    const auto events = generate("burst", params, 10000, 1000.0, 5);
    int inside = 0;
    for (const Event& e : events) {
        const double x = static_cast<double>(e.timestamp) / (1000.0 * kTicksPerSecond);
        if (e.type == EventType::Connect && x >= 0.5 && x < 0.55) ++inside;
    }
    // 기대 비율: 0.05*50 / (0.95 + 0.05*50) ≈ 72%
    CHECK(inside > 6000);
}

void unknownParamsAreReported() {
    Params params;
    params.set("peak_ratoi", "3");
    makeBuiltinRegistry().find("peak")->create(params);
    CHECK(params.unusedKeys() == std::vector<std::string>{"peak_ratoi"});

    Params mixed;
    mixed.set("duration", "exp:10");  // mixed는 short/long_duration을 쓴다
    makeBuiltinRegistry().find("mixed")->create(mixed);
    CHECK(mixed.unusedKeys() == std::vector<std::string>{"duration"});
}

void invalidInputsAreRejected() {
    CHECK(throws([] { parseDistribution("gamma:1:2"); }));
    CHECK(throws([] { parseDistribution("exp:-1"); }));
    CHECK(throws([] { parseDistribution("uniform:5"); }));
    CHECK(throws([] { parseDistribution("const:abc"); }));
    Params params;
    params.set("peak_ratio", "0.5");
    CHECK(throws([&] { makeBuiltinRegistry().find("peak")->create(params); }));
}

void distributionsSample() {
    Rng rng(9);
    CHECK(parseDistribution("const:3")->sample(rng) == 3.0);
    const auto randint = parseDistribution("randint:2:4");
    const auto discrete = parseDistribution("discrete:1=1,7=0");
    for (int i = 0; i < 1000; ++i) {
        const double v = randint->sample(rng);
        CHECK(v == 2.0 || v == 3.0 || v == 4.0);
        CHECK(discrete->sample(rng) == 1.0);
    }
}

}  // namespace

int main() {
    lb::enableUtf8Console();
    const std::pair<const char*, std::function<void()>> tests[] = {
        {"everyScenarioSatisfiesConstraints", everyScenarioSatisfiesConstraints},
        {"sameSeedIsReproducible", sameSeedIsReproducible},
        {"collidingTimesStayUnique", collidingTimesStayUnique},
        {"csvRoundTrip", csvRoundTrip},
        {"validatorCatchesViolations", validatorCatchesViolations},
        {"peakConcentratesArrivals", peakConcentratesArrivals},
        {"burstAtFixedPositions", burstAtFixedPositions},
        {"unknownParamsAreReported", unknownParamsAreReported},
        {"invalidInputsAreRejected", invalidInputsAreRejected},
        {"distributionsSample", distributionsSample},
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
