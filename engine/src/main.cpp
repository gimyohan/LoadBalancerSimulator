#include <algorithm>
#include <filesystem>
#include <format>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "lb/console.hpp"
#include "lb/event.hpp"
#include "lb/params.hpp"
#include "lb/registry.hpp"
#include "result_writer.hpp"
#include "server_spec.hpp"
#include "simulation.hpp"
#include "strategies/builtin.hpp"

namespace {

using namespace lb;
using namespace lb::sim;

const std::vector<ParamInfo> kCommonParams = {
    {"events", "(필수)", "이벤트 데이터셋 CSV (데이터 생성기 출력)"},
    {"servers", "(필수)", "서버 구성. '크기' 또는 '개수x크기'를 쉼표로 나열 (예: 10x500, 4x100,2x250)"},
    {"strategy", "(필수)", "전략 이름. 쉼표로 여러 개, 'all'이면 전체 (--list로 확인)"},
    {"output", "results/<events 파일 이름>", "결과 디렉터리. 전략마다 하위 디렉터리를 만든다"},
    {"sample_interval", "0", "사용량 스냅샷 간격(ms). 0이면 samples에 맞춰 자동"},
    {"samples", "1000", "sample_interval이 0일 때 스냅샷 수"},
};

void printUsage(std::ostream& out) {
    out << "사용법: lb_simulator [--config FILE] key=value ...\n"
           "        lb_simulator --list\n\n"
           "인자는 앞에서부터 적용되며, 같은 키는 나중 값이 이긴다.\n"
           "전략 파라미터(seed 등)는 같은 key=value로 넘기며, 지정한 모든 전략에 적용된다.\n\n"
           "공통 파라미터:\n";
    printParamTable(out, kCommonParams);
}

std::vector<Event> loadEvents(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("이벤트 파일을 열 수 없다: " + path);
    std::vector<Event> events = readEventsCsv(in);
    std::stable_sort(events.begin(), events.end(),
                     [](const Event& a, const Event& b) { return a.timestamp < b.timestamp; });
    if (const auto errors = validateEvents(events); !errors.empty()) {
        std::string message = "이벤트 데이터셋이 제약 조건을 어긴다 (" + std::to_string(errors.size()) + "건)";
        for (std::size_t i = 0; i < std::min<std::size_t>(errors.size(), 5); ++i) message += "\n  " + errors[i];
        throw std::invalid_argument(message);
    }
    return events;
}

std::vector<std::string> strategyNames(const std::string& value, const StrategyRegistry& registry) {
    std::vector<std::string> names;
    if (value == "all") {
        for (const StrategyInfo& info : registry.all()) names.push_back(info.name);
        return names;
    }
    for (std::string_view name : split(value, ',')) {
        if (!registry.find(name)) {
            throw std::invalid_argument("알 수 없는 전략: " + std::string(name) + " (--list로 확인)");
        }
        names.emplace_back(name);
    }
    return names;
}

constexpr const char* kTableFormat = "{:<20} {:>9} {:>9} {:>10} {:>8} {:>10} {:>10} {:>12} {:>12}\n";

void printHeader(std::ostream& out) {
    out << std::format(kTableFormat, "strategy", "accepted", "rejected", "violations", "reject%", "util_mean",
                       "util_var", "sel_mean_ns", "sel_p99_ns");
}

void printRow(std::ostream& out, const std::string& name, const SimulationResult& r) {
    out << std::format(kTableFormat, name, r.accepted, r.rejected, r.violations,
                       std::format("{:.2f}", r.rejectionRate() * 100.0), std::format("{:.4f}", r.utilization_mean),
                       std::format("{:.5f}", r.utilization_variance_mean), std::format("{:.1f}", r.timing.mean_ns),
                       r.timing.p99_ns);
}

int run(int argc, char** argv) {
    CommandLine command = parseCommandLine(argc, argv);
    Params& params = command.params;
    if (command.help) {
        printUsage(std::cout);
        return 0;
    }

    const StrategyRegistry registry = makeBuiltinStrategies();
    if (command.list) {
        printRegistry(std::cout, registry);
        return 0;
    }

    const std::string events_file = params.getString("events", "");
    const std::string servers_spec = params.getString("servers", "");
    const std::string strategy_value = params.getString("strategy", "");
    if (events_file.empty() || servers_spec.empty() || strategy_value.empty()) {
        printUsage(std::cerr);
        return 2;
    }
    const std::vector<Weight> capacities = parseServerSpec(servers_spec);
    const std::filesystem::path output =
        params.getString("output", "results/" + std::filesystem::path(events_file).stem().string());
    const SimulationOptions options{params.getInt("sample_interval", 0), params.getInt("samples", 1000)};

    // 실행 전에 모든 전략을 만들어 파라미터 오타를 먼저 잡는다.
    std::vector<std::pair<std::string, std::unique_ptr<Strategy>>> strategies;
    for (const std::string& name : strategyNames(strategy_value, registry)) {
        strategies.emplace_back(name, registry.find(name)->create(params));
    }
    rejectUnusedKeys(params, "전략");

    const std::vector<Event> events = loadEvents(events_file);
    std::cerr << std::format("이벤트 {}개, 서버 {}대, 전략 {}개\n", events.size(), capacities.size(),
                             strategies.size());
    printHeader(std::cerr);
    for (auto& [name, strategy] : strategies) {
        const SimulationResult result = runSimulation(events, capacities, *strategy, options);
        writeResults(output / name, RunInfo{name, events_file, servers_spec, params.values()}, result);
        printRow(std::cerr, name, result);
    }
    std::cerr << "출력: " << output.string() << '\n';
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    lb::enableUtf8Console();
    try {
        return run(argc, argv);
    } catch (const std::exception& e) {
        std::cerr << "오류: " << e.what() << '\n';
        return 1;
    }
}
