#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "distribution.hpp"
#include "lb/event.hpp"
#include "params.hpp"
#include "random.hpp"

namespace lb::gen {

// 시나리오가 만드는 세션 하나. 시각은 초 단위 실수이고, 정수 TIMESTAMP 변환과
// 시각 중복 제거는 buildEvents()가 맡는다.
struct SessionSpec {
    double connect_time;  // [0, horizon)
    double duration;      // > 0
    Weight weight;        // >= 1
};

struct GenerationRequest {
    std::int64_t sessions;  // 생성할 세션 수
    double horizon;         // 연결이 도착하는 구간 길이(초)
};

// 모든 시나리오의 공통 인터페이스. 시나리오별 설정은 생성자에서 Params로 받는다.
class Scenario {
public:
    virtual ~Scenario() = default;
    virtual std::vector<SessionSpec> generate(const GenerationRequest& request, Rng& rng) = 0;
};

inline constexpr const char* kDefaultDurationSpec = "lognormal:300:1.0";
inline constexpr const char* kDefaultWeightSpec = "const:1";

// 연결 도착을 비균질 포아송 과정으로 모델링하는 시나리오의 기반 클래스.
// 하위 클래스는 상대적인 도착 강도 λ(t)만 정의하면 된다. 세션 수 N이 정해져 있으면
// 포아송 과정의 도착 시각은 λ(t)에 비례하는 밀도에서 독립으로 뽑은 N개와 같으므로,
// 기각 샘플링으로 정확히 N개를 만든다.
//
// 지속 시간과 가중치는 기본적으로 'duration', 'weight' 파라미터의 분포를 따르며,
// 시점에 따라 달라져야 하면 sampleDuration/sampleWeight를 재정의한다.
class IntensityScenario : public Scenario {
public:
    std::vector<SessionSpec> generate(const GenerationRequest& request, Rng& rng) final;

protected:
    // default_duration이 nullopt면 'duration' 파라미터를 읽지 않으므로
    // 하위 클래스가 sampleDuration을 반드시 재정의해야 한다.
    IntensityScenario(const Params& params, std::optional<std::string> default_duration);

    // 도착 시각을 뽑기 전에 한 번 호출된다. 무작위 버스트 위치 같은 준비에 쓴다.
    virtual void prepare(double horizon, Rng& rng);
    // 시각 t(초)의 상대 도착 강도. 0 이상이고 maxIntensity() 이하여야 한다.
    virtual double intensity(double t, double horizon) const = 0;
    virtual double maxIntensity() const = 0;

    virtual double sampleDuration(double connect_time, Rng& rng) const;
    virtual Weight sampleWeight(double connect_time, Rng& rng) const;

private:
    std::unique_ptr<Distribution> duration_;
    std::unique_ptr<Distribution> weight_;
};

}  // namespace lb::gen
