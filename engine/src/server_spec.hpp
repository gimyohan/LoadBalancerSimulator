#pragma once

#include <string_view>
#include <vector>

#include "lb/event.hpp"

namespace lb::sim {

// 서버 구성 표기를 서버별 크기 목록으로 바꾼다. 항목은 쉼표로 구분하고,
// 각 항목은 "크기" 또는 "개수x크기"다. 예: "10x500", "100,100,200", "4x100,2x250".
// 형식이 틀리거나 값이 1보다 작으면 std::invalid_argument.
std::vector<Weight> parseServerSpec(std::string_view spec);

}  // namespace lb::sim
