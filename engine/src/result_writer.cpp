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
    row("utilization_mean", r.utilization_mean);
    row("utilization_variance_mean", r.utilization_variance_mean);
    row("server_utilization_variance", r.server_utilization_variance);
    row("peak_total_load", r.peak_total_load);
    row("select_ns_mean", r.timing.mean_ns);
    row("select_ns_min", r.timing.min_ns);
    row("select_ns_p50", r.timing.p50_ns);
    row("select_ns_p95", r.timing.p95_ns);
    row("select_ns_p99", r.timing.p99_ns);
    row("select_ns_max", r.timing.max_ns);
    row("select_ns_total", r.timing.total_ns);
    row("timer_resolution_ns", r.timing.resolution_ns);
    row("timer_overhead_ns", r.timing.overhead_ns);
    for (const auto& [key, value] : info.params) row("param." + key, value);
}

void writeServers(std::ostream& out, const SimulationResult& r) {
    out << "server_id,capacity,accepted_sessions,peak_load,peak_utilization,mean_load,mean_utilization\n";
    for (std::size_t id = 0; id < r.servers.size(); ++id) {
        const ServerStats& s = r.servers[id];
        const auto capacity = static_cast<double>(s.capacity);
        out << std::format("{},{},{},{},{},{},{}\n", id, s.capacity, s.accepted_sessions, s.peak_load,
                           static_cast<double>(s.peak_load) / capacity, s.mean_load, s.mean_load / capacity);
    }
}

void writeTimeline(std::ostream& out, const SimulationResult& r) {
    out << "time,active_sessions,total_load,utilization_mean,utilization_variance,accepted,rejected,violations";
    for (std::size_t id = 0; id < r.servers.size(); ++id) out << ",load_" << id;
    out << '\n';
    for (const Sample& s : r.timeline) {
        out << std::format("{},{},{},{},{},{},{},{}", s.time, s.active_sessions, s.total_load, s.utilization_mean,
                           s.utilization_variance, s.accepted, s.rejected, s.violations);
        for (Weight load : s.loads) out << ',' << load;
        out << '\n';
    }
}

void writeAssignments(std::ostream& out, const SimulationResult& r) {
    out << "session_id,time,weight,server,outcome,select_ns\n";
    for (const Assignment& a : r.assignments) {
        out << std::format("{},{},{},{},{},{}\n", a.session_id, a.time, a.weight, a.server, toString(a.outcome),
                           a.select_ns);
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
}

}  // namespace lb::sim
