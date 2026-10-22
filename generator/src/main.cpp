#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <format>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "event_builder.hpp"
#include "lb/event.hpp"
#include "params.hpp"
#include "scenarios/builtin.hpp"

namespace {

using namespace lb;
using namespace lb::gen;

const std::vector<ParamInfo> kCommonParams = {
    {"scenario", "(필수)", "시나리오 이름 (--list로 확인)"},
    {"sessions", "10000", "생성할 세션 수"},
    {"horizon", "3600", "연결이 도착하는 구간 길이(초)"},
    {"seed", "1", "난수 시드. 같은 설정과 시드는 항상 같은 데이터셋을 만든다"},
    {"output", "data/<scenario>.csv", "출력 CSV 경로 ('-'이면 표준 출력)"},
};

void printParams(std::ostream& out, const std::vector<ParamInfo>& params) {
    std::size_t width = 0;
    for (const ParamInfo& p : params) width = std::max(width, p.name.size());
    for (const ParamInfo& p : params) {
        out << std::format("  {:<{}}  {}  [기본값: {}]\n", p.name, width, p.description,
                           p.default_value.empty() ? "없음" : p.default_value);
    }
}

void printUsage(std::ostream& out) {
    out << "사용법: lb_generator [--config FILE] key=value ...\n"
           "        lb_generator --list\n\n"
           "인자는 앞에서부터 적용되며, 같은 키는 나중 값이 이긴다.\n\n"
           "공통 파라미터:\n";
    printParams(out, kCommonParams);
    out << '\n' << distributionHelp();
}

void printScenarios(std::ostream& out, const ScenarioRegistry& registry) {
    for (const ScenarioInfo& info : registry.all()) {
        out << info.name << " - " << info.description << '\n';
        printParams(out, info.params);
        out << '\n';
    }
}

void printSummary(std::ostream& out, const std::string& scenario, const Params& params,
                  const std::vector<Event>& events) {
    std::unordered_map<SessionId, Timestamp> connected_at;
    std::int64_t sessions = 0, concurrent = 0, peak_concurrent = 0;
    Weight total_weight = 0, load = 0, peak_load = 0;
    double total_duration = 0.0;
    for (const Event& e : events) {
        if (e.type == EventType::Connect) {
            ++sessions;
            total_weight += e.weight;
            connected_at[e.session_id] = e.timestamp;
            peak_concurrent = std::max(peak_concurrent, ++concurrent);
            peak_load = std::max(peak_load, load += e.weight);
        } else {
            --concurrent;
            load -= e.weight;
            total_duration += static_cast<double>(e.timestamp - connected_at[e.session_id]) / kTicksPerSecond;
        }
    }

    out << "시나리오: " << scenario << '\n' << "파라미터:";
    for (const auto& [key, value] : params.values()) out << ' ' << key << '=' << value;
    out << '\n'
        << std::format("세션 {}개, 이벤트 {}개, 마지막 시각 {}ms\n", sessions, events.size(),
                       events.empty() ? 0 : events.back().timestamp)
        << std::format("평균 지속 시간 {:.1f}초, 평균 가중치 {:.2f}\n",
                       sessions ? total_duration / static_cast<double>(sessions) : 0.0,
                       sessions ? static_cast<double>(total_weight) / static_cast<double>(sessions) : 0.0)
        << std::format("최대 동시 세션 {}개, 최대 총 가중치 {}\n", peak_concurrent, peak_load);
}

int run(int argc, char** argv) {
    Params params;
    bool list = false;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            printUsage(std::cout);
            return 0;
        }
        if (arg == "--list") {
            list = true;
        } else if (arg == "--config") {
            if (++i >= argc) throw std::invalid_argument("--config 뒤에 파일 경로가 필요하다");
            loadParamsFile(argv[i], params);
        } else {
            auto [key, value] = parseAssignment(arg);
            params.set(key, value);
        }
    }

    const ScenarioRegistry registry = makeBuiltinRegistry();
    if (list) {
        printScenarios(std::cout, registry);
        return 0;
    }

    const std::string name = params.getString("scenario", "");
    if (name.empty()) {
        printUsage(std::cerr);
        return 2;
    }
    const ScenarioInfo* info = registry.find(name);
    if (!info) throw std::invalid_argument("알 수 없는 시나리오: " + name + " (--list로 확인)");

    const GenerationRequest request{params.getInt("sessions", 10000), params.getDouble("horizon", 3600.0)};
    if (request.sessions < 1) throw std::invalid_argument("sessions: 1 이상이어야 한다");
    if (request.horizon <= 0.0) throw std::invalid_argument("horizon: 0보다 커야 한다");
    const auto seed = static_cast<std::uint64_t>(params.getInt("seed", 1));
    const std::string output = params.getString("output", "data/" + name + ".csv");

    auto scenario = info->create(params);
    if (const auto unused = params.unusedKeys(); !unused.empty()) {
        std::string keys;
        for (const std::string& key : unused) keys += ' ' + key;
        throw std::invalid_argument("시나리오 '" + name + "'가 쓰지 않는 파라미터:" + keys);
    }

    Rng rng(seed);
    const std::vector<Event> events = buildEvents(scenario->generate(request, rng));
    if (const auto errors = validateEvents(events); !errors.empty()) {
        throw std::logic_error("생성된 데이터셋이 제약 조건을 어긴다: " + errors.front());
    }

    if (output == "-") {
        writeEventsCsv(std::cout, events);
    } else {
        const std::filesystem::path path(output);
        if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
        std::ofstream out(path, std::ios::binary);
        if (!out) throw std::runtime_error("출력 파일을 열 수 없다: " + output);
        writeEventsCsv(out, events);
        if (!out.flush()) throw std::runtime_error("출력 파일 쓰기 실패: " + output);
        std::cerr << "출력: " << output << '\n';
    }
    printSummary(std::cerr, name, params, events);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
#endif
    try {
        return run(argc, argv);
    } catch (const std::exception& e) {
        std::cerr << "오류: " << e.what() << '\n';
        return 1;
    }
}
