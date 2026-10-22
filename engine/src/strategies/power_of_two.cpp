#include <algorithm>
#include <stdexcept>

#include "lb/random.hpp"
#include "strategies/builtin.hpp"

namespace lb::sim {

namespace {

constexpr std::int64_t kDefaultSeed = 1;
constexpr std::int64_t kDefaultChoices = 2;

// 무작위로 고른 d개 서버만 보고 그중 이용률이 가장 낮은 서버에 넣는다 (power of d choices).
// 전체를 훑지 않으므로 서버가 많아도 선택 비용이 일정하다. 후보 중 들어가는 서버가 없으면 거절한다.
class PowerOfTwoStrategy final : public Strategy {
public:
    explicit PowerOfTwoStrategy(const Params& params)
        : rng_(static_cast<std::uint64_t>(params.getInt("seed", kDefaultSeed))),
          choices_(params.getInt("choices", kDefaultChoices)) {
        if (choices_ < 1) throw std::invalid_argument("choices: 1 이상이어야 한다");
    }

    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        const auto n = static_cast<double>(cluster.serverCount());
        std::optional<ServerId> best;
        for (std::int64_t k = 0; k < choices_; ++k) {
            const auto id = std::min(static_cast<ServerId>(uniform01(rng_) * n), cluster.serverCount() - 1);
            if (!cluster.fits(id, request.weight)) continue;
            if (!best || cluster.load(id) * cluster.capacity(*best) < cluster.load(*best) * cluster.capacity(id)) {
                best = id;
            }
        }
        return best;
    }

private:
    Rng rng_;
    std::int64_t choices_;
};

}  // namespace

StrategyInfo powerOfTwoStrategy() {
    return {"power_of_two", "power of two choices: 무작위 후보 d개 중 이용률이 낮은 서버를 고른다",
            {{"choices", std::to_string(kDefaultChoices), "후보 수 d (중복 허용)"},
             {"seed", std::to_string(kDefaultSeed), "난수 시드"}},
            [](const Params& p) { return std::make_unique<PowerOfTwoStrategy>(p); }};
}

}  // namespace lb::sim
