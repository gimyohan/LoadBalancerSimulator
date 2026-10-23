#include "simulation.hpp"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <numeric>
#include <set>
#include <stdexcept>
#include <unordered_map>
#include <utility>

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

CountStats summarizeCounts(std::vector<std::int64_t> samples) {
    CountStats stats;
    if (samples.empty()) return stats;
    std::sort(samples.begin(), samples.end());
    for (std::int64_t s : samples) stats.total += s;
    stats.mean = static_cast<double>(stats.total) / static_cast<double>(samples.size());
    stats.p50 = samples[samples.size() / 2];
    stats.p99 = samples[std::min(samples.size() - 1, static_cast<std::size_t>(0.99 * static_cast<double>(samples.size())))];
    stats.max = samples.back();
    return stats;
}

// (값, 가중치) 목록의 가중 평균과 가중 분위수.
WeightedStats summarizeWeighted(std::vector<std::pair<double, double>> samples, double empty_value) {
    WeightedStats stats{empty_value, empty_value, empty_value, empty_value, empty_value};
    double total = 0.0;
    double weighted_sum = 0.0;
    for (const auto& [value, weight] : samples) {
        total += weight;
        weighted_sum += value * weight;
    }
    if (total <= 0.0) return stats;
    std::sort(samples.begin(), samples.end());
    const auto quantile = [&](double q) {
        double cumulative = 0.0;
        for (const auto& [value, weight] : samples) {
            cumulative += weight;
            if (cumulative >= q * total) return value;
        }
        return samples.back().first;
    };
    stats.mean = weighted_sum / total;
    stats.p01 = quantile(0.01);
    stats.p05 = quantile(0.05);
    stats.p95 = quantile(0.95);
    stats.p99 = quantile(0.99);
    return stats;
}

// 서버 이용률의 평균·분산·최댓값과 서버별 사용량·포화 시간 적분을 증분으로 유지한다.
// 이벤트마다 서버 전체를 훑지 않으므로 사용량 변경 하나가 O(log n)이다.
class UsageTracker {
public:
    UsageTracker(std::vector<ServerState>& servers, Timestamp start, double hot_threshold)
        : servers_(servers),
          hot_threshold_(hot_threshold),
          area_(servers.size(), 0.0),
          hot_time_(servers.size(), 0),
          full_time_(servers.size(), 0),
          last_change_(servers.size(), start) {
        for (ServerId id = 0; id < servers.size(); ++id) by_utilization_.emplace(0.0, id);
    }

    void changeLoad(ServerId id, Weight delta, Timestamp now) {
        accumulate(id, now);
        ServerState& s = servers_[id];
        const double before = utilization(id);
        s.load += delta;
        const double after = utilization(id);
        sum_u_ += after - before;
        sum_u2_ += after * after - before * before;
        by_utilization_.erase({before, id});
        by_utilization_.emplace(after, id);
    }

    double mean() const { return sum_u_ / static_cast<double>(servers_.size()); }
    double variance() const {
        const double m = mean();
        return std::max(0.0, sum_u2_ / static_cast<double>(servers_.size()) - m * m);
    }

    BalanceIndex balance() const {
        const double max_u = by_utilization_.rbegin()->first;
        const double m = mean();
        if (max_u <= 0.0 || m <= 0.0) return {};  // 부하가 없으면 완전 균형으로 본다
        const auto n = static_cast<double>(servers_.size());
        return {max_u / m, std::sqrt(variance()) / m, std::clamp(sum_u_ * sum_u_ / (n * sum_u2_), 1.0 / n, 1.0)};
    }

    // now까지 적분한 값. 사용량 면적은 load × ms, 포화 시간은 ms.
    double area(ServerId id, Timestamp now) const {
        return area_[id] + static_cast<double>(servers_[id].load) * static_cast<double>(now - last_change_[id]);
    }
    Timestamp hotTime(ServerId id, Timestamp now) const {
        return hot_time_[id] + (utilization(id) >= hot_threshold_ ? now - last_change_[id] : 0);
    }
    Timestamp fullTime(ServerId id, Timestamp now) const {
        return full_time_[id] + (isFull(id) ? now - last_change_[id] : 0);
    }

private:
    void accumulate(ServerId id, Timestamp now) {
        area_[id] = area(id, now);
        hot_time_[id] = hotTime(id, now);
        full_time_[id] = fullTime(id, now);
        last_change_[id] = now;
    }

    double utilization(ServerId id) const {
        return static_cast<double>(servers_[id].load) / static_cast<double>(servers_[id].capacity);
    }
    bool isFull(ServerId id) const { return servers_[id].load >= servers_[id].capacity; }

    std::vector<ServerState>& servers_;
    double hot_threshold_;
    std::vector<double> area_;
    std::vector<Timestamp> hot_time_;
    std::vector<Timestamp> full_time_;
    std::vector<Timestamp> last_change_;
    std::set<std::pair<double, ServerId>> by_utilization_;
    double sum_u_ = 0.0;
    double sum_u2_ = 0.0;
};

// 2의 거듭제곱 가중치 구간: 1, 2–3, 4–7, ...
std::size_t weightClass(Weight weight) {
    return static_cast<std::size_t>(std::bit_width(static_cast<std::uint64_t>(weight)) - 1);
}

}  // namespace

std::string_view toString(Outcome outcome) {
    switch (outcome) {
        case Outcome::Accepted: return "accepted";
        case Outcome::Rejected: return "rejected";
        case Outcome::Violation: return "violation";
    }
    return "unknown";
}

std::string_view toString(RejectReason reason) {
    switch (reason) {
        case RejectReason::None: return "";
        case RejectReason::Capacity: return "capacity";
        case RejectReason::Fragmentation: return "fragmentation";
        case RejectReason::Avoidable: return "avoidable";
    }
    return "";
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
    if (!(options.hot_threshold > 0.0 && options.hot_threshold <= 1.0)) {
        throw std::invalid_argument("hot_threshold는 (0, 1] 범위여야 한다");
    }
    for (std::size_t i = 1; i < events.size(); ++i) {
        if (events[i].timestamp < events[i - 1].timestamp) {
            throw std::invalid_argument("이벤트가 시각 순으로 정렬돼 있지 않다");
        }
    }

    const std::size_t n = capacities.size();
    std::vector<ServerState> servers(n);
    SimulationResult result;
    result.hot_threshold = options.hot_threshold;
    for (std::size_t id = 0; id < n; ++id) {
        servers[id].capacity = capacities[id];
        result.servers.push_back(ServerStats{capacities[id], 0, 0, 0, 0, 0.0, 0, 0, 0.0, 0.0});
    }
    const Weight total_capacity = std::accumulate(capacities.begin(), capacities.end(), Weight{0});
    ClusterView view(servers);
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

    UsageTracker usage(servers, start, options.hot_threshold);
    std::unordered_map<SessionId, ServerId> placed;
    placed.reserve(events.size() / 2);
    std::vector<std::int64_t> select_ns, queries, inspected;
    select_ns.reserve(events.size() / 2);
    queries.reserve(events.size() / 2);
    inspected.reserve(events.size() / 2);
    result.assignments.reserve(events.size() / 2);
    std::vector<WeightClassStats> classes(64);
    // 균형 지수의 (값, 부하 × 시간) 표본
    std::vector<std::pair<double, double>> imbalance_samples, cv_samples, jain_samples;

    std::int64_t active = 0;
    Weight total_load = 0;
    double mean_area = 0.0;
    double variance_area = 0.0;
    Timestamp previous = start;
    Timestamp next_sample = start;

    const auto snapshot = [&](Timestamp t) {
        Sample sample{t, active, total_load, usage.mean(), usage.variance(), usage.balance(),
                      result.connects, result.accepted, result.rejected, result.violations, {}};
        sample.loads.reserve(n);
        for (const ServerState& s : servers) sample.loads.push_back(s.load);
        result.timeline.push_back(std::move(sample));
    };

    // 전략이 거절한 순간의 클러스터 상태로 원인을 나눈다. 엔진 내부 계산이라 조회 수에 들어가지 않는다.
    const auto classifyRejection = [&](Weight weight) {
        if (total_capacity - total_load < weight) return RejectReason::Capacity;
        const bool some_server_fits = std::any_of(servers.begin(), servers.end(), [&](const ServerState& s) {
            return s.capacity - s.load >= weight;
        });
        return some_server_fits ? RejectReason::Avoidable : RejectReason::Fragmentation;
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
        if (const double load_time = dt * static_cast<double>(total_load); load_time > 0.0) {
            const BalanceIndex b = usage.balance();
            imbalance_samples.emplace_back(b.imbalance, load_time);
            cv_samples.emplace_back(b.cv, load_time);
            jain_samples.emplace_back(b.jain, load_time);
        }
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
        result.requested_weight += e.weight;
        WeightClassStats& weight_class = classes[weightClass(e.weight)];
        ++weight_class.requests;
        weight_class.requested_weight += e.weight;

        const ConnectRequest request{e.session_id, e.timestamp, e.weight};
        view.beginDecision();
        const auto begin = Clock::now();
        const std::optional<ServerId> choice = strategy.selectServer(request, view);
        const std::int64_t ns = elapsedNs(begin, Clock::now());
        select_ns.push_back(ns);
        queries.push_back(view.queries());
        inspected.push_back(view.serversInspected());

        Assignment assignment{e.session_id, e.timestamp, e.weight, -1, Outcome::Rejected, RejectReason::None,
                              ns, view.queries(), view.serversInspected()};
        if (!choice) {
            ++result.rejected;
            ++weight_class.rejected;
            assignment.reject_reason = classifyRejection(e.weight);
            switch (assignment.reject_reason) {
                case RejectReason::Capacity: ++result.rejected_capacity; break;
                case RejectReason::Fragmentation: ++result.rejected_fragmentation; break;
                case RejectReason::Avoidable: ++result.rejected_avoidable; break;
                case RejectReason::None: break;
            }
        } else if (*choice >= n || servers[*choice].capacity - servers[*choice].load < e.weight) {
            const bool exists = *choice < n;
            ++result.violations;
            ++weight_class.violations;
            assignment.server = static_cast<std::int64_t>(*choice);
            assignment.outcome = Outcome::Violation;
            result.violation_log.push_back(ViolationRecord{
                e.session_id, e.timestamp, e.weight, assignment.server,
                exists ? servers[*choice].capacity - servers[*choice].load : -1,
                exists ? "남은 용량이 세션 가중치보다 작다" : "존재하지 않는 서버"});
        } else {
            const ServerId id = *choice;
            ++result.accepted;
            ++weight_class.accepted;
            usage.changeLoad(id, e.weight, e.timestamp);
            ++servers[id].sessions;
            ++active;
            total_load += e.weight;
            placed.emplace(e.session_id, id);
            ServerStats& stats = result.servers[id];
            ++stats.accepted_sessions;
            stats.accepted_weight += e.weight;
            stats.peak_load = std::max(stats.peak_load, servers[id].load);
            stats.peak_sessions = std::max(stats.peak_sessions, servers[id].sessions);
            result.peak_total_load = std::max(result.peak_total_load, total_load);
            assignment.server = static_cast<std::int64_t>(id);
            assignment.outcome = Outcome::Accepted;
        }
        if (assignment.outcome != Outcome::Accepted) {
            result.rejected_weight += e.weight;
            weight_class.rejected_weight += e.weight;
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
    double total_area = 0.0;
    for (std::size_t id = 0; id < n; ++id) total_area += usage.area(id, end);
    double sum = 0.0;
    double sum_sq = 0.0;
    double hot_total = 0.0;
    double full_total = 0.0;
    for (std::size_t id = 0; id < n; ++id) {
        ServerStats& stats = result.servers[id];
        const double area = usage.area(id, end);
        stats.mean_load = span > 0 ? area / span : 0.0;
        stats.hot_time = usage.hotTime(id, end);
        stats.full_time = usage.fullTime(id, end);
        stats.load_share = total_area > 0 ? area / total_area : 0.0;
        stats.capacity_share = static_cast<double>(stats.capacity) / static_cast<double>(total_capacity);
        hot_total += static_cast<double>(stats.hot_time);
        full_total += static_cast<double>(stats.full_time);
        const double u = stats.mean_load / static_cast<double>(stats.capacity);
        sum += u;
        sum_sq += u * u;
    }
    const double mean_u = sum / static_cast<double>(n);
    result.server_utilization_variance = std::max(0.0, sum_sq / static_cast<double>(n) - mean_u * mean_u);
    if (span > 0) {
        result.hot_time_fraction = hot_total / (span * static_cast<double>(n));
        result.full_time_fraction = full_total / (span * static_cast<double>(n));
    }

    result.imbalance = summarizeWeighted(std::move(imbalance_samples), 1.0);
    result.cv = summarizeWeighted(std::move(cv_samples), 0.0);
    result.jain = summarizeWeighted(std::move(jain_samples), 1.0);
    for (std::size_t k = 0; k < classes.size(); ++k) {
        if (classes[k].requests == 0) continue;
        classes[k].weight_min = Weight{1} << k;
        classes[k].weight_max = (Weight{1} << (k + 1)) - 1;
        result.weight_classes.push_back(classes[k]);
    }
    result.timing = summarizeTiming(std::move(select_ns));
    result.queries = summarizeCounts(std::move(queries));
    result.servers_inspected = summarizeCounts(std::move(inspected));
    return result;
}

}  // namespace lb::sim
