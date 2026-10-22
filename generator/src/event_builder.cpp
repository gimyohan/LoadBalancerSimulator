#include "event_builder.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <tuple>

namespace lb::gen {

std::vector<Event> buildEvents(const std::vector<SessionSpec>& sessions) {
    std::vector<std::size_t> order(sessions.size());
    std::iota(order.begin(), order.end(), 0);
    std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) {
        return sessions[a].connect_time < sessions[b].connect_time;
    });

    struct Pending {
        double time;
        SessionId id;
        EventType type;
        Weight weight;
    };
    std::vector<Pending> pending;
    pending.reserve(sessions.size() * 2);
    constexpr double kMinDuration = 1.0 / kTicksPerSecond;
    for (std::size_t i = 0; i < order.size(); ++i) {
        const SessionSpec& s = sessions[order[i]];
        const auto id = static_cast<SessionId>(i + 1);
        pending.push_back({s.connect_time, id, EventType::Connect, s.weight});
        pending.push_back({s.connect_time + std::max(s.duration, kMinDuration), id, EventType::Disconnect, s.weight});
    }
    // 시각이 같으면 세션 ID, 그다음 연결 먼저 순으로 고정해 결과를 결정적으로 만든다.
    std::sort(pending.begin(), pending.end(), [](const Pending& a, const Pending& b) {
        return std::tie(a.time, a.id, a.type) < std::tie(b.time, b.id, b.type);
    });

    std::vector<Event> events;
    events.reserve(pending.size());
    Timestamp previous = -1;
    for (const Pending& p : pending) {
        const Timestamp tick = std::max<Timestamp>(std::llround(p.time * kTicksPerSecond), previous + 1);
        events.push_back(Event{p.id, p.type, tick, p.weight});
        previous = tick;
    }
    return events;
}

}  // namespace lb::gen
