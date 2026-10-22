#include "scenarios/builtin.hpp"

namespace lb::gen {

ScenarioRegistry makeBuiltinRegistry() {
    ScenarioRegistry registry;
    registry.add(uniformScenario());
    registry.add(peakScenario());
    registry.add(burstScenario());
    registry.add(mixedScenario());
    return registry;
}

}  // namespace lb::gen
