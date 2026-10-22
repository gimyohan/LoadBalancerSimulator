#include <cmath>
#include <format>
#include <stdexcept>

#include "scenarios/builtin.hpp"

namespace lb::gen {

namespace {

constexpr const char* kDefaultCenters = "0.5";
constexpr double kDefaultWidth = 0.1;
constexpr double kDefaultRatio = 5.0;

// 기본 강도 1 위에 가우시안 모양의 피크를 더한다. 피크 중심에서 강도는 peak_ratio가 된다.
class PeakScenario final : public IntensityScenario {
public:
    explicit PeakScenario(const Params& params)
        : IntensityScenario(params, kDefaultDurationSpec),
          centers_(params.getDoubleList("peak_center", kDefaultCenters)),
          width_(params.getDouble("peak_width", kDefaultWidth)),
          ratio_(params.getDouble("peak_ratio", kDefaultRatio)) {
        if (centers_.empty()) throw std::invalid_argument("peak_center: 피크가 하나 이상 있어야 한다");
        for (double c : centers_) {
            if (c < 0.0 || c > 1.0) throw std::invalid_argument("peak_center: 0~1 사이여야 한다");
        }
        if (width_ <= 0.0) throw std::invalid_argument("peak_width: 0보다 커야 한다");
        if (ratio_ < 1.0) throw std::invalid_argument("peak_ratio: 1 이상이어야 한다");
    }

protected:
    double intensity(double t, double horizon) const override {
        const double x = t / horizon;
        double bump = 0.0;
        for (double c : centers_) {
            const double z = (x - c) / width_;
            bump += std::exp(-0.5 * z * z);
        }
        return 1.0 + (ratio_ - 1.0) * bump;
    }

    // 피크가 겹칠 수 있으므로 피크 수만큼 더한 값을 상한으로 쓴다.
    double maxIntensity() const override {
        return 1.0 + (ratio_ - 1.0) * static_cast<double>(centers_.size());
    }

private:
    std::vector<double> centers_;
    double width_;
    double ratio_;
};

}  // namespace

ScenarioInfo peakScenario() {
    auto params = sessionProfileParams(kDefaultDurationSpec);
    params.insert(params.begin(),
                  {{"peak_center", kDefaultCenters, "피크 중심 위치(구간 대비 0~1, 쉼표로 여러 개)"},
                   {"peak_width", std::format("{}", kDefaultWidth), "피크 폭(표준편차, 구간 대비 비율)"},
                   {"peak_ratio", std::format("{}", kDefaultRatio), "피크 중심의 도착률 / 평상시 도착률"}});
    return {"peak", "피크 시간대: 특정 시간대에 연결이 몰렸다가 다시 줄어든다", std::move(params),
            [](const Params& p) { return std::make_unique<PeakScenario>(p); }};
}

}  // namespace lb::gen
