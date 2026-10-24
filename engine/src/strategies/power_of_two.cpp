#include <algorithm>
#include <stdexcept>
#include <string>
#include <vector>

#include "lb/random.hpp"
#include "strategies/builtin.hpp"

namespace lb::sim {

namespace {

constexpr std::int64_t kDefaultSeed = 1;
constexpr std::int64_t kDefaultChoices = 2;

// 이용률(load / capacity)이 a가 b보다 낮은가. 크기가 다른 서버를 정수로 비교한다.
bool lessUtilized(const ClusterView& cluster, ServerId a, ServerId b) {
    return cluster.load(a) * cluster.capacity(b) < cluster.load(b) * cluster.capacity(a);
}

ServerId randomServer(Rng& rng, std::size_t count) {
    return std::min(static_cast<ServerId>(uniform01(rng) * static_cast<double>(count)), count - 1);
}

// 무작위로 고른 d개 서버만 보고 그중 이용률이 가장 낮은 서버에 넣는다 (power of d choices).
// 전체를 훑지 않으므로 서버가 많아도 선택 비용이 일정하다. 후보 중 들어가는 서버가 없으면 거절한다.
class PowerOfChoicesStrategy final : public Strategy {
public:
    PowerOfChoicesStrategy(std::int64_t seed, std::int64_t choices)
        : rng_(static_cast<std::uint64_t>(seed)), choices_(choices) {
        if (choices_ < 1) throw std::invalid_argument("choices: 1 이상이어야 한다");
    }

    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        std::optional<ServerId> best;
        for (std::int64_t k = 0; k < choices_; ++k) {
            const ServerId id = randomServer(rng_, cluster.serverCount());
            if (!cluster.fits(id, request.weight)) continue;
            if (!best || lessUtilized(cluster, id, *best)) best = id;
        }
        return best;
    }

private:
    Rng rng_;
    std::int64_t choices_;
};

// 세션이 들어갈 수 있는 서버만 모은 뒤 그중 서로 다른 둘을 무작위로 골라 이용률이 낮은 쪽에 넣는다.
// 들어갈 서버가 하나라도 있으면 거절하지 않는 대신, 후보를 모으려고 매번 모든 서버를 본다.
class FeasiblePowerOfTwoStrategy final : public Strategy {
public:
    explicit FeasiblePowerOfTwoStrategy(std::int64_t seed) : rng_(static_cast<std::uint64_t>(seed)) {}

    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        pool_.clear();
        for (ServerId id = 0; id < cluster.serverCount(); ++id) {
            if (cluster.fits(id, request.weight)) pool_.push_back(id);
        }
        if (pool_.empty()) return std::nullopt;
        const std::size_t first = randomServer(rng_, pool_.size());
        if (pool_.size() == 1) return pool_[first];
        // 두 번째 후보는 첫 번째를 뺀 나머지에서 고른다.
        std::size_t second = randomServer(rng_, pool_.size() - 1);
        if (second >= first) ++second;
        return lessUtilized(cluster, pool_[second], pool_[first]) ? pool_[second] : pool_[first];
    }

private:
    Rng rng_;
    std::vector<ServerId> pool_;
};

// power_of_n 시리즈가 같은 문장으로 설명되도록 후보 수 표기만 바꿔 쓴다.
std::string choicesDescription(const std::string& d) {
    return "power of d choices (d=" + d +
           "): 무작위 후보 d개(중복 허용) 중 이용률이 가장 낮은 서버를 고른다. 후보가 모두 차 있으면 거절한다";
}

// 후보 수를 이름으로 고정한 power_of_n. choices를 받지 않는다.
// strategy=all처럼 여러 전략을 함께 돌릴 때 power_of_two와 후보 수를 따로 두기 위해서다.
StrategyInfo fixedChoicesStrategy(const std::string& name, std::int64_t choices) {
    return {name, choicesDescription(std::to_string(choices)),
            {{"seed", std::to_string(kDefaultSeed), "난수 시드"}},
            [choices](const Params& p) {
                return std::make_unique<PowerOfChoicesStrategy>(p.getInt("seed", kDefaultSeed), choices);
            }};
}

}  // namespace

StrategyInfo powerOfTwoStrategy() {
    return {"power_of_two", choicesDescription("choices"),
            {{"choices", std::to_string(kDefaultChoices), "후보 수 d"},
             {"seed", std::to_string(kDefaultSeed), "난수 시드"}},
            [](const Params& p) {
                return std::make_unique<PowerOfChoicesStrategy>(p.getInt("seed", kDefaultSeed),
                                                                p.getInt("choices", kDefaultChoices));
            }};
}

StrategyInfo powerOfFourStrategy() { return fixedChoicesStrategy("power_of_four", 4); }

StrategyInfo powerOfEightStrategy() { return fixedChoicesStrategy("power_of_eight", 8); }

StrategyInfo feasiblePowerOfTwoStrategy() {
    return {"feasible_power_of_two",
            "들어갈 수 있는 서버 중 power of two: 들어가는 서버만 모아 무작위 둘 중 이용률이 낮은 서버를 고른다",
            {{"seed", std::to_string(kDefaultSeed), "난수 시드"}},
            [](const Params& p) { return std::make_unique<FeasiblePowerOfTwoStrategy>(p.getInt("seed", kDefaultSeed)); }};
}

}  // namespace lb::sim
