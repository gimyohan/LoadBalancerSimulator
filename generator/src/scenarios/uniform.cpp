#include "scenarios/builtin.hpp"

namespace lb::gen {

namespace {

class UniformScenario final : public IntensityScenario {
public:
    explicit UniformScenario(const Params& params) : IntensityScenario(params, kDefaultDurationSpec) {}

protected:
    double intensity(double, double) const override { return 1.0; }
    double maxIntensity() const override { return 1.0; }
};

}  // namespace

ScenarioInfo uniformScenario() {
    return {"uniform", "균일 트래픽: 시간에 걸쳐 일정한 비율로 연결이 도착한다",
            sessionProfileParams(kDefaultDurationSpec),
            [](const Params& params) { return std::make_unique<UniformScenario>(params); }};
}

}  // namespace lb::gen
