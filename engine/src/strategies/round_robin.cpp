#include "strategies/builtin.hpp"

namespace lb::sim {

namespace {

// 직전 선택 다음 서버부터 차례로 보며 세션이 들어가는 첫 서버를 고른다.
class RoundRobinStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        const std::size_t n = cluster.serverCount();
        for (std::size_t k = 0; k < n; ++k) {
            const ServerId id = (next_ + k) % n;
            if (cluster.fits(id, request.weight)) {
                next_ = (id + 1) % n;
                return id;
            }
        }
        return std::nullopt;
    }

private:
    ServerId next_ = 0;
};

// 용량을 보지 않고 순서대로만 고른다. 위반 감지를 확인하기 위한 기준선이다.
class BlindRoundRobinStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest&, const ClusterView& cluster) override {
        const ServerId id = next_;
        next_ = (next_ + 1) % cluster.serverCount();
        return id;
    }

private:
    ServerId next_ = 0;
};

}  // namespace

StrategyInfo roundRobinStrategy() {
    return {"round_robin", "라운드 로빈: 순서대로 돌며 남은 용량이 충분한 다음 서버를 고른다", {},
            [](const Params&) { return std::make_unique<RoundRobinStrategy>(); }};
}

StrategyInfo blindRoundRobinStrategy() {
    return {"blind_round_robin", "용량 무시 라운드 로빈: 남은 용량을 확인하지 않는 기준선 (위반 발생)", {},
            [](const Params&) { return std::make_unique<BlindRoundRobinStrategy>(); }};
}

}  // namespace lb::sim
