#pragma once

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
class ClusterView {
public:
    explicit ClusterView(const std::vector<ServerState>& servers) : servers_(servers) {}

    std::size_t serverCount() const { return servers_.size(); }
    const ServerState& server(ServerId id) const { return servers_[id]; }
    std::span<const ServerState> servers() const { return servers_; }

    Weight capacity(ServerId id) const { return servers_[id].capacity; }
    Weight load(ServerId id) const { return servers_[id].load; }
    std::int64_t sessionCount(ServerId id) const { return servers_[id].sessions; }
    Weight remaining(ServerId id) const { return capacity(id) - load(id); }
    bool fits(ServerId id, Weight weight) const { return remaining(id) >= weight; }
    double utilization(ServerId id) const {
        return static_cast<double>(load(id)) / static_cast<double>(capacity(id));
    }

private:
    const std::vector<ServerState>& servers_;
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
