#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "params.hpp"
#include "scenario.hpp"

namespace lb::gen {

struct ParamInfo {
    std::string name;
    std::string default_value;
    std::string description;
};

struct ScenarioInfo {
    std::string name;
    std::string description;
    std::vector<ParamInfo> params;
    std::function<std::unique_ptr<Scenario>(const Params&)> create;
};

// 이름으로 시나리오를 찾고 만든다. 등록 순서대로 목록을 유지한다.
class ScenarioRegistry {
public:
    void add(ScenarioInfo info);  // 이름이 겹치면 std::invalid_argument
    const ScenarioInfo* find(std::string_view name) const;
    const std::vector<ScenarioInfo>& all() const { return infos_; }

private:
    std::vector<ScenarioInfo> infos_;
};

// IntensityScenario가 읽는 'duration', 'weight' 파라미터 설명.
// default_duration이 nullopt면 'weight'만 돌려준다.
std::vector<ParamInfo> sessionProfileParams(std::optional<std::string> default_duration);

}  // namespace lb::gen
