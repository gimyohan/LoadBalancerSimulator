#include <algorithm>
#include <vector>

#include "lb/random.hpp"
#include "strategies/builtin.hpp"

namespace lb::sim {

namespace {

constexpr std::int64_t kDefaultSeed = 1;

// 세션이 들어가는 서버 중 하나를 균등하게 고른다.
class RandomStrategy final : public Strategy {
public:
    explicit RandomStrategy(const Params& params)
        : rng_(static_cast<std::uint64_t>(params.getInt("seed", kDefaultSeed))) {}

    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        candidates_.clear();
        for (ServerId id = 0; id < cluster.serverCount(); ++id) {
            if (cluster.fits(id, request.weight)) candidates_.push_back(id);
        }
        if (candidates_.empty()) return std::nullopt;
        const auto index = static_cast<std::size_t>(uniform01(rng_) * static_cast<double>(candidates_.size()));
        return candidates_[std::min(index, candidates_.size() - 1)];
    }

private:
    Rng rng_;
    std::vector<ServerId> candidates_;
};

}  // namespace

StrategyInfo randomStrategy() {
    return {"random", "무작위: 세션이 들어가는 서버 중 하나를 균등하게 고른다",
            {{"seed", std::to_string(kDefaultSeed), "난수 시드"}},
            [](const Params& p) { return std::make_unique<RandomStrategy>(p); }};
}

}  // namespace lb::sim
