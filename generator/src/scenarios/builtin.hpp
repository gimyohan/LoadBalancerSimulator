#pragma once

#include "scenario_registry.hpp"

namespace lb::gen {

// 기본 시나리오. 새 시나리오는 scenarios/에 파일을 만들고 여기에 선언한 뒤
// makeBuiltinRegistry()에 등록한다.
ScenarioInfo uniformScenario();
ScenarioInfo peakScenario();
ScenarioInfo burstScenario();
ScenarioInfo mixedScenario();

ScenarioRegistry makeBuiltinRegistry();

}  // namespace lb::gen
