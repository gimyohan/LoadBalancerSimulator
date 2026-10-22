#include "scenario_registry.hpp"

namespace lb::gen {

std::vector<ParamInfo> sessionProfileParams(std::optional<std::string> default_duration) {
    std::vector<ParamInfo> params;
    if (default_duration) params.push_back({"duration", *default_duration, "세션 지속 시간 분포(초)"});
    params.push_back({"weight", kDefaultWeightSpec, "세션 가중치 분포 (반올림, 최소 1)"});
    return params;
}

}  // namespace lb::gen
