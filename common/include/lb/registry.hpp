#pragma once

#include <functional>
#include <iosfwd>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "lb/params.hpp"

namespace lb {

struct ParamInfo {
    std::string name;
    std::string default_value;
    std::string description;
};

// 이름으로 고를 수 있는 구현(시나리오, 전략 등) 하나의 등록 정보.
template <typename Product>
struct RegistryEntry {
    std::string name;
    std::string description;
    std::vector<ParamInfo> params;
    std::function<std::unique_ptr<Product>(const Params&)> create;
};

// 등록 순서대로 목록을 유지한다.
template <typename Product>
class Registry {
public:
    using Entry = RegistryEntry<Product>;

    void add(Entry entry) {
        if (find(entry.name)) throw std::invalid_argument("이름이 중복된다: " + entry.name);
        entries_.push_back(std::move(entry));
    }

    const Entry* find(std::string_view name) const {
        for (const Entry& entry : entries_) {
            if (entry.name == name) return &entry;
        }
        return nullptr;
    }

    const std::vector<Entry>& all() const { return entries_; }

private:
    std::vector<Entry> entries_;
};

// "  name  설명  [기본값: x]" 형식으로 출력한다 (--help, --list용).
void printParamTable(std::ostream& out, const std::vector<ParamInfo>& params);

template <typename Product>
void printRegistry(std::ostream& out, const Registry<Product>& registry) {
    for (const auto& entry : registry.all()) {
        out << entry.name << " - " << entry.description << '\n';
        printParamTable(out, entry.params);
        out << '\n';
    }
}

}  // namespace lb
