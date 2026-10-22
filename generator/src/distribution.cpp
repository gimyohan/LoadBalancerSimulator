#include "distribution.hpp"

#include <algorithm>
#include <cmath>
#include <span>
#include <stdexcept>
#include <string_view>
#include <vector>

#include "lb/params.hpp"

namespace lb::gen {

namespace {

class ConstantDistribution final : public Distribution {
public:
    explicit ConstantDistribution(double value) : value_(value) {}
    double sample(Rng&) const override { return value_; }

private:
    double value_;
};

class UniformDistribution final : public Distribution {
public:
    UniformDistribution(double low, double high) : low_(low), high_(high) {}
    double sample(Rng& rng) const override { return uniform(rng, low_, high_); }

private:
    double low_, high_;
};

// 양 끝을 포함하는 정수 균등 분포.
class RandIntDistribution final : public Distribution {
public:
    RandIntDistribution(double low, double high) : low_(low), high_(high) {}
    double sample(Rng& rng) const override {
        return std::min(high_, low_ + std::floor(uniform01(rng) * (high_ - low_ + 1.0)));
    }

private:
    double low_, high_;
};

class ExponentialDistribution final : public Distribution {
public:
    explicit ExponentialDistribution(double mean) : mean_(mean) {}
    double sample(Rng& rng) const override { return exponential(rng, mean_); }

private:
    double mean_;
};

class NormalDistribution final : public Distribution {
public:
    NormalDistribution(double mean, double stddev) : mean_(mean), stddev_(stddev) {}
    double sample(Rng& rng) const override { return mean_ + stddev_ * standardNormal(rng); }

private:
    double mean_, stddev_;
};

// median * exp(sigma * Z). 평균 대신 중앙값으로 지정하는 편이 직관적이다.
class LogNormalDistribution final : public Distribution {
public:
    LogNormalDistribution(double median, double sigma) : median_(median), sigma_(sigma) {}
    double sample(Rng& rng) const override { return median_ * std::exp(sigma_ * standardNormal(rng)); }

private:
    double median_, sigma_;
};

// 꼬리가 두꺼운 분포. alpha가 작을수록 아주 큰 값이 자주 나온다.
class ParetoDistribution final : public Distribution {
public:
    ParetoDistribution(double xmin, double alpha) : xmin_(xmin), alpha_(alpha) {}
    double sample(Rng& rng) const override {
        return xmin_ / std::pow(1.0 - uniform01(rng), 1.0 / alpha_);
    }

private:
    double xmin_, alpha_;
};

class DiscreteDistribution final : public Distribution {
public:
    DiscreteDistribution(std::vector<double> values, std::vector<double> cumulative)
        : values_(std::move(values)), cumulative_(std::move(cumulative)) {}
    double sample(Rng& rng) const override {
        const double u = uniform01(rng) * cumulative_.back();
        const auto it = std::upper_bound(cumulative_.begin(), cumulative_.end(), u);
        const auto index = std::min<std::size_t>(it - cumulative_.begin(), values_.size() - 1);
        return values_[index];
    }

private:
    std::vector<double> values_;
    std::vector<double> cumulative_;
};

using Args = std::span<const std::string_view>;

struct DistributionKind {
    std::string_view name;
    std::string_view usage;
    std::size_t arity;
    std::unique_ptr<Distribution> (*make)(Args args, const std::string& spec);
};

void require(bool condition, const std::string& spec, std::string_view rule) {
    if (!condition) throw std::invalid_argument("분포 '" + spec + "': " + std::string(rule));
}

std::unique_ptr<Distribution> makeDiscrete(Args args, const std::string& spec) {
    std::vector<double> values;
    std::vector<double> cumulative;
    double total = 0.0;
    for (std::string_view item : split(args[0], ',')) {
        const auto eq = item.find('=');
        require(eq != std::string_view::npos, spec, "항목은 값=확률 형식이어야 한다");
        const double probability = parseDouble(item.substr(eq + 1), spec);
        require(probability >= 0.0, spec, "확률은 0 이상이어야 한다");
        values.push_back(parseDouble(item.substr(0, eq), spec));
        total += probability;
        cumulative.push_back(total);
    }
    require(total > 0.0, spec, "확률의 합이 0보다 커야 한다");
    return std::make_unique<DiscreteDistribution>(std::move(values), std::move(cumulative));
}

// 새 분포는 클래스를 만들고 이 표에 한 줄 추가하면 된다.
constexpr DistributionKind kKinds[] = {
    {"const", "const:V", 1,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         return std::make_unique<ConstantDistribution>(parseDouble(a[0], s));
     }},
    {"uniform", "uniform:LOW:HIGH  (실수 균등)", 2,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         const double low = parseDouble(a[0], s), high = parseDouble(a[1], s);
         require(low <= high, s, "LOW <= HIGH 이어야 한다");
         return std::make_unique<UniformDistribution>(low, high);
     }},
    {"randint", "randint:LOW:HIGH  (양 끝 포함 정수 균등)", 2,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         const double low = static_cast<double>(parseInt(a[0], s));
         const double high = static_cast<double>(parseInt(a[1], s));
         require(low <= high, s, "LOW <= HIGH 이어야 한다");
         return std::make_unique<RandIntDistribution>(low, high);
     }},
    {"exp", "exp:MEAN", 1,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         const double mean = parseDouble(a[0], s);
         require(mean > 0.0, s, "MEAN > 0 이어야 한다");
         return std::make_unique<ExponentialDistribution>(mean);
     }},
    {"normal", "normal:MEAN:STDDEV", 2,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         const double mean = parseDouble(a[0], s), stddev = parseDouble(a[1], s);
         require(stddev >= 0.0, s, "STDDEV >= 0 이어야 한다");
         return std::make_unique<NormalDistribution>(mean, stddev);
     }},
    {"lognormal", "lognormal:MEDIAN:SIGMA", 2,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         const double median = parseDouble(a[0], s), sigma = parseDouble(a[1], s);
         require(median > 0.0 && sigma >= 0.0, s, "MEDIAN > 0, SIGMA >= 0 이어야 한다");
         return std::make_unique<LogNormalDistribution>(median, sigma);
     }},
    {"pareto", "pareto:XMIN:ALPHA", 2,
     [](Args a, const std::string& s) -> std::unique_ptr<Distribution> {
         const double xmin = parseDouble(a[0], s), alpha = parseDouble(a[1], s);
         require(xmin > 0.0 && alpha > 0.0, s, "XMIN > 0, ALPHA > 0 이어야 한다");
         return std::make_unique<ParetoDistribution>(xmin, alpha);
     }},
    {"discrete", "discrete:V=P,V=P,...  (확률은 자동 정규화)", 1, makeDiscrete},
};

}  // namespace

std::unique_ptr<Distribution> parseDistribution(const std::string& spec) {
    const std::vector<std::string_view> parts = split(spec, ':');
    for (const DistributionKind& kind : kKinds) {
        if (kind.name != parts[0]) continue;
        const Args args = Args(parts).subspan(1);
        require(args.size() == kind.arity, spec, "형식은 " + std::string(kind.usage));
        return kind.make(args, spec);
    }
    throw std::invalid_argument("알 수 없는 분포: '" + spec + "'\n" + distributionHelp());
}

std::string distributionHelp() {
    std::string help = "분포 spec:\n";
    for (const DistributionKind& kind : kKinds) help += "  " + std::string(kind.usage) + '\n';
    return help;
}

}  // namespace lb::gen
