#pragma once

#include <optional>
#include <string>
#include <vector>

#include "lb/registry.hpp"
#include "scenario.hpp"

namespace lb::gen {

using ScenarioInfo = RegistryEntry<Scenario>;
using ScenarioRegistry = Registry<Scenario>;

// IntensityScenario가 읽는 'duration', 'weight' 파라미터 설명.
// default_duration이 nullopt면 'weight'만 돌려준다.
std::vector<ParamInfo> sessionProfileParams(std::optional<std::string> default_duration);

}  // namespace lb::gen
