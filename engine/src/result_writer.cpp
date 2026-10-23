#include "result_writer.hpp"

#include <format>
#include <fstream>
#include <numeric>

#include "lb/io.hpp"

namespace lb::sim {

namespace {

template <typename Write>
void writeFile(const std::filesystem::path& path, Write write) {
    std::ofstream out = openOutputFile(path);
    write(out);
    closeOutputFile(out, path);
}

void writeSummary(std::ostream& out, const RunInfo& info, const SimulationResult& r) {
    const Weight total_capacity = std::accumulate(r.servers.begin(), r.servers.end(), Weight{0},
                                                  [](Weight acc, const ServerStats& s) { return acc + s.capacity; });
    const auto row = [&](std::string_view key, const auto& value) {
        out << key << ',' << csvField(std::format("{}", value)) << '\n';
    };
    out << "metric,value\n";
    row("strategy", info.strategy);
    row("strategy_description", info.strategy_description);
    for (const auto& [key, value] : info.strategy_params) row("strategy_param." + key, value);
    row("events_file", info.events_file);
    row("servers", info.servers_spec);
    row("server_count", r.servers.size());
    row("total_capacity", total_capacity);
    row("start_time", r.start_time);
    row("end_time", r.end_time);
    row("connects", r.connects);
    row("accepted", r.accepted);
    row("rejected", r.rejected);
    row("violations", r.violations);
    row("rejected_total", r.rejectedTotal());
    row("rejection_rate", r.rejectionRate());
    row("rejected_capacity", r.rejected_capacity);
    row("rejected_fragmentation", r.rejected_fragmentation);
    row("rejected_avoidable", r.rejected_avoidable);
    row("requested_weight", r.requested_weight);
    row("rejected_weight", r.rejected_weight);
    row("weighted_rejection_rate", r.weightedRejectionRate());
    row("utilization_mean", r.utilization_mean);
    row("utilization_variance_mean", r.utilization_variance_mean);
    row("server_utilization_variance", r.server_utilization_variance);
    row("peak_total_load", r.peak_total_load);
    // 균형 지수: 부하 × 시간 가중. Jain은 낮을수록 나쁘므로 아래쪽 분위수를 쓴다.
    row("imbalance_mean", r.imbalance.mean);
    row("imbalance_p95", r.imbalance.p95);
    row("imbalance_p99", r.imbalance.p99);
    row("cv_mean", r.cv.mean);
    row("cv_p95", r.cv.p95);
    row("cv_p99", r.cv.p99);
    row("jain_mean", r.jain.mean);
    row("jain_p05", r.jain.p05);
    row("jain_p01", r.jain.p01);
    row("hot_threshold", r.hot_threshold);
    row("hot_time_fraction", r.hot_time_fraction);
    row("full_time_fraction", r.full_time_fraction);
    row("select_ns_mean", r.timing.mean_ns);
    row("select_ns_min", r.timing.min_ns);
    row("select_ns_p50", r.timing.p50_ns);
    row("select_ns_p95", r.timing.p95_ns);
    row("select_ns_p99", r.timing.p99_ns);
    row("select_ns_max", r.timing.max_ns);
    row("select_ns_total", r.timing.total_ns);
    row("timer_resolution_ns", r.timing.resolution_ns);
    row("timer_overhead_ns", r.timing.overhead_ns);
    row("decision_queries_mean", r.queries.mean);
    row("decision_queries_p99", r.queries.p99);
    row("decision_queries_max", r.queries.max);
    row("decision_servers_mean", r.servers_inspected.mean);
    row("decision_servers_p99", r.servers_inspected.p99);
    row("decision_servers_max", r.servers_inspected.max);
    for (const auto& [key, value] : info.params) row("param." + key, value);
}

void writeServers(std::ostream& out, const SimulationResult& r) {
    out << "server_id,capacity,accepted_sessions,accepted_weight,peak_load,peak_utilization,peak_sessions,"
           "mean_load,mean_utilization,hot_time,full_time,hot_time_fraction,full_time_fraction,"
           "load_share,capacity_share\n";
    const auto span = static_cast<double>(r.end_time - r.start_time);
    const auto fraction = [&](Timestamp t) { return span > 0 ? static_cast<double>(t) / span : 0.0; };
    for (std::size_t id = 0; id < r.servers.size(); ++id) {
        const ServerStats& s = r.servers[id];
        const auto capacity = static_cast<double>(s.capacity);
        out << std::format("{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n", id, s.capacity, s.accepted_sessions,
                           s.accepted_weight, s.peak_load, static_cast<double>(s.peak_load) / capacity,
                           s.peak_sessions, s.mean_load, s.mean_load / capacity, s.hot_time, s.full_time,
                           fraction(s.hot_time), fraction(s.full_time), s.load_share, s.capacity_share);
    }
}

void writeTimeline(std::ostream& out, const SimulationResult& r) {
    out << "time,active_sessions,total_load,utilization_mean,utilization_variance,imbalance,cv,jain,"
           "connects,accepted,rejected,violations";
    for (std::size_t id = 0; id < r.servers.size(); ++id) out << ",load_" << id;
    out << '\n';
    for (const Sample& s : r.timeline) {
        out << std::format("{},{},{},{},{},{},{},{},{},{},{},{}", s.time, s.active_sessions, s.total_load,
                           s.utilization_mean, s.utilization_variance, s.balance.imbalance, s.balance.cv,
                           s.balance.jain, s.connects, s.accepted, s.rejected, s.violations);
        for (Weight load : s.loads) out << ',' << load;
        out << '\n';
    }
}

void writeAssignments(std::ostream& out, const SimulationResult& r) {
    out << "session_id,time,weight,server,outcome,reject_reason,select_ns,queries,servers_inspected\n";
    for (const Assignment& a : r.assignments) {
        out << std::format("{},{},{},{},{},{},{},{},{}\n", a.session_id, a.time, a.weight, a.server,
                           toString(a.outcome), toString(a.reject_reason), a.select_ns, a.queries,
                           a.servers_inspected);
    }
}

void writeWeightClasses(std::ostream& out, const SimulationResult& r) {
    out << "weight_min,weight_max,requests,accepted,rejected,violations,rejection_rate,"
           "requested_weight,rejected_weight\n";
    for (const WeightClassStats& c : r.weight_classes) {
        const double rate = c.requests ? static_cast<double>(c.rejected + c.violations) / static_cast<double>(c.requests) : 0.0;
        out << std::format("{},{},{},{},{},{},{},{},{}\n", c.weight_min, c.weight_max, c.requests, c.accepted,
                           c.rejected, c.violations, rate, c.requested_weight, c.rejected_weight);
    }
}

void writeViolations(std::ostream& out, const SimulationResult& r) {
    out << "session_id,time,weight,chosen_server,remaining,reason\n";
    for (const ViolationRecord& v : r.violation_log) {
        out << std::format("{},{},{},{},{},{}\n", v.session_id, v.time, v.weight, v.chosen_server, v.remaining,
                           csvField(v.reason));
    }
}

}  // namespace

void writeResults(const std::filesystem::path& directory, const RunInfo& info, const SimulationResult& result) {
    writeFile(directory / "summary.csv", [&](std::ostream& out) { writeSummary(out, info, result); });
    writeFile(directory / "servers.csv", [&](std::ostream& out) { writeServers(out, result); });
    writeFile(directory / "timeline.csv", [&](std::ostream& out) { writeTimeline(out, result); });
    writeFile(directory / "assignments.csv", [&](std::ostream& out) { writeAssignments(out, result); });
    writeFile(directory / "violations.csv", [&](std::ostream& out) { writeViolations(out, result); });
    writeFile(directory / "weight_classes.csv", [&](std::ostream& out) { writeWeightClasses(out, result); });
}

}  // namespace lb::sim
