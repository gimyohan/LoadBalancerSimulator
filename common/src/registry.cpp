#include "lb/registry.hpp"

#include <algorithm>
#include <format>
#include <ostream>

namespace lb {

void printParamTable(std::ostream& out, const std::vector<ParamInfo>& params) {
    std::size_t width = 0;
    for (const ParamInfo& p : params) width = std::max(width, p.name.size());
    for (const ParamInfo& p : params) {
        out << std::format("  {:<{}}  {}  [기본값: {}]\n", p.name, width, p.description,
                           p.default_value.empty() ? "없음" : p.default_value);
    }
}

}  // namespace lb
