#include <format>
#include <stdexcept>

#include "scenarios/builtin.hpp"

namespace lb::gen {

namespace {

constexpr double kDefaultShortRatio = 0.8;
constexpr const char* kDefaultShortDuration = "exp:30";
constexpr const char* kDefaultLongDuration = "lognormal:1200:0.5";

// 도착은 균일하고, 지속 시간이 짧은 세션과 긴 세션이 섞여 있다.
class MixedScenario final : public IntensityScenario {
public:
    explicit MixedScenario(const Params& params)
        : IntensityScenario(params, std::nullopt),
          short_ratio_(params.getDouble("short_ratio", kDefaultShortRatio)),
          short_(parseDistribution(params.getString("short_duration", kDefaultShortDuration))),
          long_(parseDistribution(params.getString("long_duration", kDefaultLongDuration))) {
        if (short_ratio_ < 0.0 || short_ratio_ > 1.0) {
            throw std::invalid_argument("short_ratio: 0~1 사이여야 한다");
        }
    }

protected:
    double intensity(double, double) const override { return 1.0; }
    double maxIntensity() const override { return 1.0; }

    double sampleDuration(double, Rng& rng) const override {
        return uniform01(rng) < short_ratio_ ? short_->sample(rng) : long_->sample(rng);
    }

private:
    double short_ratio_;
    std::unique_ptr<Distribution> short_;
    std::unique_ptr<Distribution> long_;
};

}  // namespace

ScenarioInfo mixedScenario() {
    auto params = sessionProfileParams(std::nullopt);
    params.insert(params.begin(),
                  {{"short_ratio", std::format("{}", kDefaultShortRatio), "단기 세션 비율(0~1)"},
                   {"short_duration", kDefaultShortDuration, "단기 세션 지속 시간 분포(초)"},
                   {"long_duration", kDefaultLongDuration, "장기 세션 지속 시간 분포(초)"}});
    return {"mixed", "장기/단기 세션 혼합: 지속 시간 분포가 크게 다른 세션들이 섞여 있다", std::move(params),
            [](const Params& p) { return std::make_unique<MixedScenario>(p); }};
}

}  // namespace lb::gen
