#include <algorithm>
#include <format>
#include <stdexcept>

#include "scenarios/builtin.hpp"

namespace lb::gen {

namespace {

constexpr std::int64_t kDefaultBursts = 3;
constexpr double kDefaultLength = 0.01;
constexpr double kDefaultRatio = 30.0;

// 기본 강도 1에 burst_length 동안 강도가 burst_ratio로 치솟는 구간을 둔다.
// 경계가 날카로워 피크 시나리오보다 훨씬 급격한 부하 변화를 만든다.
class BurstScenario final : public IntensityScenario {
public:
    explicit BurstScenario(const Params& params)
        : IntensityScenario(params, kDefaultDurationSpec),
          count_(params.getInt("bursts", kDefaultBursts)),
          starts_(params.getDoubleList("burst_at", "")),
          length_(params.getDouble("burst_length", kDefaultLength)),
          ratio_(params.getDouble("burst_ratio", kDefaultRatio)) {
        if (count_ < 0) throw std::invalid_argument("bursts: 0 이상이어야 한다");
        if (length_ <= 0.0 || length_ > 1.0) throw std::invalid_argument("burst_length: (0, 1] 범위여야 한다");
        if (ratio_ < 1.0) throw std::invalid_argument("burst_ratio: 1 이상이어야 한다");
        for (double s : starts_) {
            if (s < 0.0 || s > 1.0) throw std::invalid_argument("burst_at: 0~1 사이여야 한다");
        }
    }

protected:
    void prepare(double, Rng& rng) override {
        if (!starts_.empty()) return;  // burst_at이 지정되면 bursts는 무시한다
        for (std::int64_t i = 0; i < count_; ++i) starts_.push_back(uniform01(rng) * (1.0 - length_));
        std::sort(starts_.begin(), starts_.end());
    }

    double intensity(double t, double horizon) const override {
        const double x = t / horizon;
        double lambda = 1.0;
        for (double s : starts_) {
            if (x >= s && x < s + length_) lambda += ratio_ - 1.0;
        }
        return lambda;
    }

    double maxIntensity() const override {
        return 1.0 + (ratio_ - 1.0) * static_cast<double>(starts_.size());
    }

private:
    std::int64_t count_;
    std::vector<double> starts_;
    double length_;
    double ratio_;
};

}  // namespace

ScenarioInfo burstScenario() {
    auto params = sessionProfileParams(kDefaultDurationSpec);
    params.insert(params.begin(),
                  {{"bursts", std::to_string(kDefaultBursts), "무작위 위치에 둘 버스트 수"},
                   {"burst_at", "", "버스트 시작 위치(구간 대비 0~1, 쉼표로 여러 개). 지정하면 bursts 무시"},
                   {"burst_length", std::format("{}", kDefaultLength), "버스트 길이(구간 대비 비율)"},
                   {"burst_ratio", std::format("{}", kDefaultRatio), "버스트 중 도착률 / 평상시 도착률"}});
    return {"burst", "버스트: 짧은 구간에 연결이 급증한다", std::move(params),
            [](const Params& p) { return std::make_unique<BurstScenario>(p); }};
}

}  // namespace lb::gen
