#pragma once

#include <vector>

#include "lb/event.hpp"
#include "scenario.hpp"

namespace lb::gen {

// 세션 목록을 TIMESTAMP 순으로 정렬된 연결/해제 이벤트로 바꾼다.
// - 세션 ID는 연결 순서대로 1부터 매긴다.
// - 초 단위 시각을 tick으로 반올림하고, 앞 이벤트와 같거나 이른 tick은 바로 다음 tick으로
//   민다. 실수 시각의 순서를 그대로 유지하므로 모든 TIMESTAMP가 서로 다르고
//   해제는 항상 연결보다 뒤에 온다.
std::vector<Event> buildEvents(const std::vector<SessionSpec>& sessions);

}  // namespace lb::gen
