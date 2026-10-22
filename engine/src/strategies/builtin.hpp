#pragma once

#include "strategy.hpp"

namespace lb::sim {

// 기본 전략. 새 전략은 strategies/에 파일을 만들고 여기에 선언한 뒤
// makeBuiltinStrategies()에 등록한다.
StrategyInfo roundRobinStrategy();
StrategyInfo blindRoundRobinStrategy();
StrategyInfo randomStrategy();
StrategyInfo leastConnectionsStrategy();
StrategyInfo leastLoadStrategy();
StrategyInfo firstFitStrategy();
StrategyInfo bestFitStrategy();
StrategyInfo powerOfTwoStrategy();

StrategyRegistry makeBuiltinStrategies();

}  // namespace lb::sim
