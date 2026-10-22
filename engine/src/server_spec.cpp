#include "server_spec.hpp"

#include <stdexcept>
#include <string>

#include "lb/params.hpp"

namespace lb::sim {

std::vector<Weight> parseServerSpec(std::string_view spec) {
    const std::string context = "servers '" + std::string(spec) + "'";
    std::vector<Weight> capacities;
    for (std::string_view item : split(spec, ',')) {
        const auto x = item.find('x');
        const std::int64_t count = x == std::string_view::npos ? 1 : parseInt(item.substr(0, x), context);
        const Weight capacity = parseInt(x == std::string_view::npos ? item : item.substr(x + 1), context);
        if (count < 1 || capacity < 1) throw std::invalid_argument(context + ": 개수와 크기는 1 이상이어야 한다");
        capacities.insert(capacities.end(), static_cast<std::size_t>(count), capacity);
    }
    return capacities;
}

}  // namespace lb::sim
