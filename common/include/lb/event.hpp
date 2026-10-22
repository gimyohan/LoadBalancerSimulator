#pragma once

#include <cstdint>
#include <iosfwd>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace lb {

// 이벤트 시각의 정수 단위. 1 tick = 1ms, 시뮬레이션 시작 시점이 0이다.
using Timestamp = std::int64_t;
using SessionId = std::int64_t;
using Weight = std::int64_t;

inline constexpr double kTicksPerSecond = 1000.0;

enum class EventType { Connect, Disconnect };

struct Event {
    SessionId session_id;
    EventType type;
    Timestamp timestamp;
    Weight weight;

    friend bool operator==(const Event&, const Event&) = default;
};

std::string_view toString(EventType type);
std::optional<EventType> parseEventType(std::string_view text);

// 헤더: session_id,type,timestamp,weight
void writeEventsCsv(std::ostream& out, const std::vector<Event>& events);
// 형식 오류가 있으면 줄 번호를 담은 std::runtime_error를 던진다.
std::vector<Event> readEventsCsv(std::istream& in);

// 데이터셋 제약 조건(세션당 연결/해제 한 쌍, 해제가 연결보다 뒤, 모든 시각이 서로 다름,
// 가중치 >= 1) 위반 내역을 돌려준다. 비어 있으면 유효하다.
std::vector<std::string> validateEvents(const std::vector<Event>& events);

}  // namespace lb
