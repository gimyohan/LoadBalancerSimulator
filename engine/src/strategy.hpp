#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <vector>

#include "lb/event.hpp"
#include "lb/registry.hpp"

namespace lb::sim {

using ServerId = std::size_t;

struct ServerState {
    Weight capacity = 0;      // 가중치 합의 상한
    Weight load = 0;          // 현재 할당된 세션 가중치 합
    std::int64_t sessions = 0;  // 현재 할당된 세션 수
};

// 전략이 서버 현황을 조회하는 읽기 전용 창. 엔진의 서버 상태를 그대로 비추므로
// 할당과 해제가 일어나면 바로 반영된다. 전략은 상태를 바꿀 수 없다.
//
// 결정 비용을 시계와 무관하게 재기 위해, 서버 하나에 대한 조회(capacity, load, fits 등
// 한 번의 호출)마다 조회 수를 세고 결정 동안 처음 본 서버 수를 따로 센다.
// servers()는 모든 서버를 한 번씩 조회한 것으로 센다.
class ClusterView {
public:
    explicit ClusterView(const std::vector<ServerState>& servers)
        : servers_(servers), seen_(servers.size(), 0) {}

    std::size_t serverCount() const { return servers_.size(); }
    const ServerState& server(ServerId id) const { return touch(id); }
    std::span<const ServerState> servers() const {
        for (ServerId id = 0; id < servers_.size(); ++id) touch(id);
        return servers_;
    }

    Weight capacity(ServerId id) const { return touch(id).capacity; }
    Weight load(ServerId id) const { return touch(id).load; }
    std::int64_t sessionCount(ServerId id) const { return touch(id).sessions; }
    Weight remaining(ServerId id) const {
        const ServerState& s = touch(id);
        return s.capacity - s.load;
    }
    bool fits(ServerId id, Weight weight) const { return remaining(id) >= weight; }
    double utilization(ServerId id) const {
        const ServerState& s = touch(id);
        return static_cast<double>(s.load) / static_cast<double>(s.capacity);
    }

    // 엔진용: 결정 하나의 조회 집계를 새로 시작하고 읽는다.
    void beginDecision() {
        queries_ = 0;
        inspected_ = 0;
        if (++epoch_ == 0) {  // 한 바퀴 돌면 표시를 지운다
            std::fill(seen_.begin(), seen_.end(), 0);
            epoch_ = 1;
        }
    }
    std::int64_t queries() const { return queries_; }
    std::int64_t serversInspected() const { return inspected_; }

private:
    const ServerState& touch(ServerId id) const {
        ++queries_;
        if (seen_[id] != epoch_) {
            seen_[id] = epoch_;
            ++inspected_;
        }
        return servers_[id];
    }

    const std::vector<ServerState>& servers_;
    mutable std::vector<std::uint32_t> seen_;
    mutable std::int64_t queries_ = 0;
    mutable std::int64_t inspected_ = 0;
    std::uint32_t epoch_ = 1;
};

struct ConnectRequest {
    SessionId session_id;
    Timestamp time;
    Weight weight;
};

// 로드 밸런싱 전략의 공통 인터페이스. 전략이 정하는 것은 연결 요청에 대한 서버 선택뿐이며,
// 해제는 엔진이 처리한다. 전략별 설정은 생성자에서 Params로 받는다.
class Strategy {
public:
    virtual ~Strategy() = default;

    // 첫 이벤트 전에 한 번 호출된다. 서버 구성에 맞춘 준비(해시 링 등)에 쓴다.
    virtual void initialize(const ClusterView& cluster) { (void)cluster; }

    // 서버를 고르거나 std::nullopt로 거절한다. 범위를 벗어난 ID나 남은 용량이 세션 가중치보다
    // 작은 서버를 돌려주면 엔진이 잘못된 행동(위반)으로 기록하고 거절과 같이 처리한다.
    virtual std::optional<ServerId> selectServer(const ConnectRequest& request, const ClusterView& cluster) = 0;
};

using StrategyInfo = RegistryEntry<Strategy>;
using StrategyRegistry = Registry<Strategy>;

}  // namespace lb::sim
