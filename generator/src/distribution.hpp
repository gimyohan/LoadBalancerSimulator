#pragma once

#include <memory>
#include <string>

#include "random.hpp"

namespace lb::gen {

// 세션 지속 시간(초)이나 가중치를 뽑는 1차원 분포.
class Distribution {
public:
    virtual ~Distribution() = default;
    virtual double sample(Rng& rng) const = 0;
};

// "이름:인자:인자" 형태의 spec으로 분포를 만든다. 예:
//   const:1  uniform:10:60  randint:1:8  exp:60  normal:10:2
//   lognormal:300:1.0  pareto:1:2.5  discrete:1=0.7,5=0.2,10=0.1
// 형식이나 인자 범위가 틀리면 std::invalid_argument.
std::unique_ptr<Distribution> parseDistribution(const std::string& spec);

// 지원하는 spec 목록 (--help 출력용).
std::string distributionHelp();

}  // namespace lb::gen
