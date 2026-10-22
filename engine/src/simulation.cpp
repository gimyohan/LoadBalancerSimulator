#include "simulation.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <unordered_map>

namespace lb::sim {

namespace {

using Clock = std::chrono::steady_clock;

std::int64_t elapsedNs(Clock::time_point begin, Clock::time_point end) {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(end - begin).count();
}

// 시계 해상도(0이 아닌 최소 간격)와 빈 구간 측정값의 평균을 잰다.
void measureClock(TimingStats& stats) {
    constexpr int kRounds = 2000;
    std::int64_t resolution = 0;
    std::int64_t empty_total = 0;
    for (int i = 0; i < kRounds; ++i) {
        const auto begin = Clock::now();
        auto end = Clock::now();
        empty_total += elapsedNs(begin, end);
        while (end == begin) end = Clock::now();
        const std::int64_t step = elapsedNs(begin, end);
        if (resolution == 0 || step < resolution) resolution = step;
    }
    stats.resolution_ns = resolution;
    stats.overhead_ns = static_cast<double>(empty_total) / kRounds;
}

TimingStats summarizeTiming(std::vector<std::int64_t> samples) {
    TimingStats stats;
    measureClock(stats);
    if (samples.empty()) return stats;
    std::sort(samples.begin(), samples.end());
    const auto at = [&](double q) {
        return samples[std::min(samples.size() - 1, static_cast<std::size_t>(q * static_cast<double>(samples.size())))];
    };
    for (std::int64_t s : samples) stats.total_ns += s;
    stats.mean_ns = static_cast<double>(stats.total_ns) / static_cast<double>(samples.size());
    stats.min_ns = samples.front();
    stats.max_ns = samples.back();
    stats.p50_ns = at(0.50);
    stats.p95_ns = at(0.95);
    stats.p99_ns = at(0.99);
    return stats;
}

// 서버 이용률의 평균·분산과 서버별 사용량 적분을 증분으로 유지한다.
// 이벤트마다 서버 전체를 훑지 않으므로 서버 수와 무관하게 O(1)이다.
class UsageTracker {
public:
    UsageTracker(std::vector<ServerState>& servers, Timestamp start)
        : servers_(servers), area_(servers.size(), 0.0), last_change_(servers.size(), start) {}

    void changeLoad(ServerId id, Weight delta, Timestamp now) {
        ServerState& s = servers_[id];
        area_[id] += static_cast<double>(s.load) * static_cast<double>(now - last_change_[id]);
        last_change_[id] = now;
        const double before = utilization(id);
        s.load += delta;
        const double after = utilization(id);
        sum_u_ += after - before;
        sum_u2_ += after * after - before * before;
    }

    double mean() const { return sum_u_ / static_cast<double>(servers_.size()); }
    double variance() const {
        const double m = mean();
        return std::max(0.0, sum_u2_ / static_cast<double>(servers_.size()) - m * m);
    }

    // now까지 적분한 사용량 면적(load × ms).
    double area(ServerId id, Timestamp now) const {
        return area_[id] + static_cast<double>(servers_[id].load) * static_cast<double>(now - last_change_[id]);
    }

private:
    double utilization(ServerId id) const {
        return static_cast<double>(servers_[id].load) / static_cast<double>(servers_[id].capacity);
    }

    std::vector<ServerState>& servers_;
    std::vector<double> area_;
    std::vector<Timestamp> last_change_;
    double sum_u_ = 0.0;
    double sum_u2_ = 0.0;
};

}  // namespace

std::string_view toString(Outcome outcome) {
    switch (outcome) {
        case Outcome::Accepted: return "accepted";
        case Outcome::Rejected: return "rejected";
        case Outcome::Violation: return "violation";
    }
    return "unknown";
}

SimulationResult runSimulation(const std::vector<Event>& events, const std::vector<Weight>& capacities,
                               Strategy& strategy, const SimulationOptions& options) {
    if (capacities.empty()) throw std::invalid_argument("서버가 하나 이상 있어야 한다");
    if (std::any_of(capacities.begin(), capacities.end(), [](Weight c) { return c < 1; })) {
        throw std::invalid_argument("서버 크기는 1 이상이어야 한다");
    }
    if (options.sample_interval < 0 || options.target_samples < 1) {
        throw std::invalid_argument("sample_interval >= 0, target_samples >= 1 이어야 한다");
    }
    for (std::size_t i = 1; i < events.size(); ++i) {
        if (events[i].timestamp < events[i - 1].timestamp) {
            throw std::invalid_argument("이벤트가 시각 순으로 정렬돼 있지 않다");
        }
    }

    const std::size_t n = capacities.size();
    std::vector<ServerState> servers(n);
    SimulationResult result;
    for (std::size_t id = 0; id < n; ++id) {
        servers[id].capacity = capacities[id];
        result.servers.push_back(ServerStats{capacities[id], 0, 0, 0.0});
    }
    const ClusterView view(servers);
    strategy.initialize(view);
    if (events.empty()) return result;

    const Timestamp start = events.front().timestamp;
    const Timestamp end = events.back().timestamp;
    result.start_time = start;
    result.end_time = end;
    const Timestamp interval = options.sample_interval > 0
                                   ? options.sample_interval
                                   : std::max<Timestamp>(1, (end - start + options.target_samples - 1) /
                                                                options.target_samples);

    UsageTracker usage(servers, start);
    std::unordered_map<SessionId, ServerId> placed;
    placed.reserve(events.size() / 2);
    std::vector<std::int64_t> select_ns;
    select_ns.reserve(events.size() / 2);
    result.assignments.reserve(events.size() / 2);

    std::int64_t active = 0;
    Weight total_load = 0;
    double mean_area = 0.0;
    double variance_area = 0.0;
    Timestamp previous = start;
    Timestamp next_sample = start;

    const auto snapshot = [&](Timestamp t) {
        Sample sample{t, active, total_load, usage.mean(), usage.variance(),
                      result.accepted, result.rejected, result.violations, {}};
        sample.loads.reserve(n);
        for (const ServerState& s : servers) sample.loads.push_back(s.load);
        result.timeline.push_back(std::move(sample));
    };

    for (const Event& e : events) {
        // 스냅샷은 그 시각까지의 이벤트를 모두 반영한 상태다.
        while (next_sample < e.timestamp) {
            snapshot(next_sample);
            next_sample += interval;
        }
        const auto dt = static_cast<double>(e.timestamp - previous);
        mean_area += usage.mean() * dt;
        variance_area += usage.variance() * dt;
        previous = e.timestamp;

        if (e.type == EventType::Disconnect) {
            // 거절되거나 위반으로 처리된 세션의 해제는 무시한다.
            const auto it = placed.find(e.session_id);
            if (it == placed.end()) continue;
            usage.changeLoad(it->second, -e.weight, e.timestamp);
            --servers[it->second].sessions;
            --active;
            total_load -= e.weight;
            placed.erase(it);
            continue;
        }

        ++result.connects;
        const ConnectRequest request{e.session_id, e.timestamp, e.weight};
        const auto begin = Clock::now();
        const std::optional<ServerId> choice = strategy.selectServer(request, view);
        const std::int64_t ns = elapsedNs(begin, Clock::now());
        select_ns.push_back(ns);

        Assignment assignment{e.session_id, e.timestamp, e.weight, -1, Outcome::Rejected, ns};
        if (!choice) {
            ++result.rejected;
        } else if (*choice >= n || !view.fits(*choice, e.weight)) {
            const bool exists = *choice < n;
            ++result.violations;
            assignment.server = static_cast<std::int64_t>(*choice);
            assignment.outcome = Outcome::Violation;
            result.violation_log.push_back(ViolationRecord{
                e.session_id, e.timestamp, e.weight, assignment.server, exists ? view.remaining(*choice) : -1,
                exists ? "남은 용량이 세션 가중치보다 작다" : "존재하지 않는 서버"});
        } else {
            const ServerId id = *choice;
            ++result.accepted;
            usage.changeLoad(id, e.weight, e.timestamp);
            ++servers[id].sessions;
            ++active;
            total_load += e.weight;
            placed.emplace(e.session_id, id);
            ServerStats& stats = result.servers[id];
            ++stats.accepted_sessions;
            stats.peak_load = std::max(stats.peak_load, servers[id].load);
            result.peak_total_load = std::max(result.peak_total_load, total_load);
            assignment.server = static_cast<std::int64_t>(id);
            assignment.outcome = Outcome::Accepted;
        }
        result.assignments.push_back(assignment);
    }
    while (next_sample <= end) {
        snapshot(next_sample);
        next_sample += interval;
    }
    if (result.timeline.back().time < end) snapshot(end);

    const auto span = static_cast<double>(end - start);
    if (span > 0) {
        result.utilization_mean = mean_area / span;
        result.utilization_variance_mean = variance_area / span;
    }
    double sum = 0.0;
    double sum_sq = 0.0;
    for (std::size_t id = 0; id < n; ++id) {
        ServerStats& stats = result.servers[id];
        stats.mean_load = span > 0 ? usage.area(id, end) / span : 0.0;
        const double u = stats.mean_load / static_cast<double>(stats.capacity);
        sum += u;
        sum_sq += u * u;
    }
    const double mean_u = sum / static_cast<double>(n);
    result.server_utilization_variance = std::max(0.0, sum_sq / static_cast<double>(n) - mean_u * mean_u);
    result.timing = summarizeTiming(std::move(select_ns));
    return result;
}

}  // namespace lb::sim
