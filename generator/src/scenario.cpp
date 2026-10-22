#include "scenario.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace lb::gen {

IntensityScenario::IntensityScenario(const Params& params, std::optional<std::string> default_duration)
    : weight_(parseDistribution(params.getString("weight", kDefaultWeightSpec))) {
    if (default_duration) duration_ = parseDistribution(params.getString("duration", *default_duration));
}

void IntensityScenario::prepare(double, Rng&) {}

std::vector<SessionSpec> IntensityScenario::generate(const GenerationRequest& request, Rng& rng) {
    prepare(request.horizon, rng);
    const double max_intensity = maxIntensity();
    if (!(max_intensity > 0.0)) throw std::logic_error("maxIntensity()는 0보다 커야 한다");

    std::vector<double> arrivals;
    arrivals.reserve(static_cast<std::size_t>(request.sessions));
    // 강도가 거의 0인 시나리오가 무한 루프에 빠지지 않도록 시도 횟수를 제한한다.
    const std::int64_t max_attempts = request.sessions * 100000 + 1000000;
    for (std::int64_t attempt = 0; std::ssize(arrivals) < request.sessions; ++attempt) {
        if (attempt >= max_attempts) {
            throw std::runtime_error("도착 시각 샘플링이 끝나지 않는다. 도착 강도가 너무 작은지 확인하라");
        }
        const double t = uniform01(rng) * request.horizon;
        const double lambda = intensity(t, request.horizon);
        if (lambda < 0.0 || lambda > max_intensity * (1.0 + 1e-9)) {
            throw std::logic_error("intensity(t)가 [0, maxIntensity()] 범위를 벗어났다");
        }
        if (uniform01(rng) * max_intensity < lambda) arrivals.push_back(t);
    }
    std::sort(arrivals.begin(), arrivals.end());

    std::vector<SessionSpec> sessions;
    sessions.reserve(arrivals.size());
    for (double t : arrivals) {
        const double duration = std::max(sampleDuration(t, rng), 0.0);
        const Weight weight = std::max<Weight>(sampleWeight(t, rng), 1);
        sessions.push_back(SessionSpec{t, duration, weight});
    }
    return sessions;
}

double IntensityScenario::sampleDuration(double, Rng& rng) const {
    if (!duration_) throw std::logic_error("duration 분포가 없으면 sampleDuration을 재정의해야 한다");
    return duration_->sample(rng);
}

Weight IntensityScenario::sampleWeight(double, Rng& rng) const {
    return static_cast<Weight>(std::llround(weight_->sample(rng)));
}

}  // namespace lb::gen
