#include "strategies/builtin.hpp"

namespace lb::sim {

namespace {

// 세션이 들어가는 서버 중 better(a, b)가 참인 쪽을 고르는 선형 탐색. 동률이면 ID가 작은 서버.
template <typename Better>
std::optional<ServerId> pickBest(const ClusterView& cluster, Weight weight, Better better) {
    std::optional<ServerId> best;
    for (ServerId id = 0; id < cluster.serverCount(); ++id) {
        if (!cluster.fits(id, weight)) continue;
        if (!best || better(id, *best)) best = id;
    }
    return best;
}

class LeastConnectionsStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        return pickBest(cluster, request.weight,
                        [&](ServerId a, ServerId b) { return cluster.sessionCount(a) < cluster.sessionCount(b); });
    }
};

// 이용률(load / capacity)이 가장 낮은 서버. 크기가 다른 서버를 비율로 비교한다.
class LeastLoadStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        return pickBest(cluster, request.weight, [&](ServerId a, ServerId b) {
            // load_a / cap_a < load_b / cap_b 를 정수로 비교한다.
            return cluster.load(a) * cluster.capacity(b) < cluster.load(b) * cluster.capacity(a);
        });
    }
};

class FirstFitStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        for (ServerId id = 0; id < cluster.serverCount(); ++id) {
            if (cluster.fits(id, request.weight)) return id;
        }
        return std::nullopt;
    }
};

// 넣은 뒤 남는 용량이 가장 작은 서버. 서버를 꽉 채워 큰 빈자리를 남기려는 bin packing 방식.
class BestFitStrategy final : public Strategy {
public:
    std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) override {
        return pickBest(cluster, request.weight,
                        [&](ServerId a, ServerId b) { return cluster.remaining(a) < cluster.remaining(b); });
    }
};

}  // namespace

StrategyInfo leastConnectionsStrategy() {
    return {"least_connections", "최소 연결: 현재 세션 수가 가장 적은 서버를 고른다", {},
            [](const Params&) { return std::make_unique<LeastConnectionsStrategy>(); }};
}

StrategyInfo leastLoadStrategy() {
    return {"least_load", "최소 이용률: 사용량/크기 비율이 가장 낮은 서버를 고른다", {},
            [](const Params&) { return std::make_unique<LeastLoadStrategy>(); }};
}

StrategyInfo firstFitStrategy() {
    return {"first_fit", "first fit: ID 순으로 보며 세션이 들어가는 첫 서버를 고른다", {},
            [](const Params&) { return std::make_unique<FirstFitStrategy>(); }};
}

StrategyInfo bestFitStrategy() {
    return {"best_fit", "best fit: 넣은 뒤 남는 용량이 가장 작은 서버를 고른다", {},
            [](const Params&) { return std::make_unique<BestFitStrategy>(); }};
}

}  // namespace lb::sim
