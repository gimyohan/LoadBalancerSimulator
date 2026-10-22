#include "scenario_registry.hpp"

#include <stdexcept>

namespace lb::gen {

void ScenarioRegistry::add(ScenarioInfo info) {
    if (find(info.name)) throw std::invalid_argument("시나리오 이름이 중복된다: " + info.name);
    infos_.push_back(std::move(info));
}

const ScenarioInfo* ScenarioRegistry::find(std::string_view name) const {
    for (const ScenarioInfo& info : infos_) {
        if (info.name == name) return &info;
    }
    return nullptr;
}

std::vector<ParamInfo> sessionProfileParams(std::optional<std::string> default_duration) {
    std::vector<ParamInfo> params;
    if (default_duration) params.push_back({"duration", *default_duration, "세션 지속 시간 분포(초)"});
    params.push_back({"weight", kDefaultWeightSpec, "세션 가중치 분포 (반올림, 최소 1)"});
    return params;
}

}  // namespace lb::gen
