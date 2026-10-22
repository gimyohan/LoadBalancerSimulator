#include "lb/event.hpp"

#include <charconv>
#include <istream>
#include <ostream>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

namespace lb {

namespace {

constexpr std::string_view kHeader = "session_id,type,timestamp,weight";

std::int64_t parseField(std::string_view text, std::size_t line_no, std::string_view field) {
    std::int64_t value{};
    const auto* end = text.data() + text.size();
    auto [ptr, ec] = std::from_chars(text.data(), end, value);
    if (ec != std::errc{} || ptr != end) {
        throw std::runtime_error("CSV " + std::to_string(line_no) + "행: " + std::string(field) +
                                 " 값이 정수가 아니다: '" + std::string(text) + "'");
    }
    return value;
}

}  // namespace

std::string_view toString(EventType type) {
    return type == EventType::Connect ? "connect" : "disconnect";
}

std::optional<EventType> parseEventType(std::string_view text) {
    if (text == "connect") return EventType::Connect;
    if (text == "disconnect") return EventType::Disconnect;
    return std::nullopt;
}

void writeEventsCsv(std::ostream& out, const std::vector<Event>& events) {
    out << kHeader << '\n';
    for (const Event& e : events) {
        out << e.session_id << ',' << toString(e.type) << ',' << e.timestamp << ',' << e.weight << '\n';
    }
}

std::vector<Event> readEventsCsv(std::istream& in) {
    std::vector<Event> events;
    std::string line;
    std::size_t line_no = 0;
    while (std::getline(in, line)) {
        ++line_no;
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;
        if (line_no == 1) {
            if (line != kHeader) {
                throw std::runtime_error("CSV 헤더가 '" + std::string(kHeader) + "'가 아니다: '" + line + "'");
            }
            continue;
        }

        std::string_view rest = line;
        std::string_view fields[4];
        for (int i = 0; i < 4; ++i) {
            const auto comma = rest.find(',');
            if ((i < 3) == (comma == std::string_view::npos)) {
                throw std::runtime_error("CSV " + std::to_string(line_no) + "행: 필드가 4개가 아니다");
            }
            fields[i] = rest.substr(0, comma);
            rest = comma == std::string_view::npos ? std::string_view{} : rest.substr(comma + 1);
        }

        const auto type = parseEventType(fields[1]);
        if (!type) {
            throw std::runtime_error("CSV " + std::to_string(line_no) + "행: 알 수 없는 type '" +
                                     std::string(fields[1]) + "'");
        }
        events.push_back(Event{parseField(fields[0], line_no, "session_id"), *type,
                               parseField(fields[2], line_no, "timestamp"),
                               parseField(fields[3], line_no, "weight")});
    }
    if (line_no == 0) throw std::runtime_error("CSV가 비어 있다");
    return events;
}

std::vector<std::string> validateEvents(const std::vector<Event>& events) {
    struct SessionRecord {
        int connects = 0;
        int disconnects = 0;
        Timestamp connect_at = 0;
        Timestamp disconnect_at = 0;
        Weight connect_weight = 0;
        Weight disconnect_weight = 0;
    };

    std::vector<std::string> errors;
    std::unordered_set<Timestamp> seen_timestamps;
    std::unordered_map<SessionId, SessionRecord> sessions;
    seen_timestamps.reserve(events.size());

    for (const Event& e : events) {
        if (!seen_timestamps.insert(e.timestamp).second) {
            errors.push_back("시각 " + std::to_string(e.timestamp) + "에 이벤트가 두 개 이상 있다");
        }
        if (e.timestamp < 0) {
            errors.push_back("세션 " + std::to_string(e.session_id) + ": 시각이 음수다");
        }
        if (e.weight < 1) {
            errors.push_back("세션 " + std::to_string(e.session_id) + ": 가중치가 1보다 작다");
        }
        SessionRecord& r = sessions[e.session_id];
        if (e.type == EventType::Connect) {
            ++r.connects;
            r.connect_at = e.timestamp;
            r.connect_weight = e.weight;
        } else {
            ++r.disconnects;
            r.disconnect_at = e.timestamp;
            r.disconnect_weight = e.weight;
        }
    }

    for (const auto& [id, r] : sessions) {
        const std::string who = "세션 " + std::to_string(id);
        if (r.connects != 1 || r.disconnects != 1) {
            errors.push_back(who + ": 연결 " + std::to_string(r.connects) + "개, 해제 " +
                             std::to_string(r.disconnects) + "개 (각각 1개여야 한다)");
            continue;
        }
        if (r.disconnect_at <= r.connect_at) errors.push_back(who + ": 해제 시각이 연결 시각보다 뒤가 아니다");
        if (r.connect_weight != r.disconnect_weight) errors.push_back(who + ": 연결/해제 가중치가 다르다");
    }
    return errors;
}

}  // namespace lb
