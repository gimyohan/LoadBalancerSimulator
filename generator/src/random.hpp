#pragma once

#include <random>

namespace lb::gen {

// mt19937_64의 출력 수열은 표준이 고정하지만 std::*_distribution의 변환 방식은
// 구현마다 다르다. 같은 시드로 어느 컴파일러에서든 같은 데이터셋이 나오도록
// 분포 변환은 아래 함수들로 직접 한다.
using Rng = std::mt19937_64;

double uniform01(Rng& rng);  // [0, 1)
double uniform(Rng& rng, double low, double high);
double standardNormal(Rng& rng);
double exponential(Rng& rng, double mean);

}  // namespace lb::gen
