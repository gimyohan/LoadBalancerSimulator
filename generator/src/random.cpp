#include "random.hpp"

#include <cmath>
#include <numbers>

namespace lb::gen {

double uniform01(Rng& rng) {
    // 상위 53비트로 double 가수부를 채운다.
    return static_cast<double>(rng() >> 11) * 0x1.0p-53;
}

double uniform(Rng& rng, double low, double high) { return low + (high - low) * uniform01(rng); }

double standardNormal(Rng& rng) {
    // Box-Muller. 1 - u는 (0, 1]이라 log(0)이 나오지 않는다.
    const double u1 = 1.0 - uniform01(rng);
    const double u2 = uniform01(rng);
    return std::sqrt(-2.0 * std::log(u1)) * std::cos(2.0 * std::numbers::pi * u2);
}

double exponential(Rng& rng, double mean) { return -mean * std::log(1.0 - uniform01(rng)); }

}  // namespace lb::gen
