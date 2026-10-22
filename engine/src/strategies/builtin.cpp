#include "strategies/builtin.hpp"

namespace lb::sim {

StrategyRegistry makeBuiltinStrategies() {
    StrategyRegistry registry;
    registry.add(roundRobinStrategy());
    registry.add(blindRoundRobinStrategy());
    registry.add(randomStrategy());
    registry.add(leastConnectionsStrategy());
    registry.add(leastLoadStrategy());
    registry.add(firstFitStrategy());
    registry.add(bestFitStrategy());
    registry.add(powerOfTwoStrategy());
    return registry;
}

}  // namespace lb::sim
