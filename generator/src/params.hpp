#pragma once

#include <cstdint>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace lb::gen {

// key=value 형태의 생성 설정. 조회된 키를 기록해 두었다가 오타 등으로
// 아무도 읽지 않은 키를 unusedKeys()로 알려준다.
class Params {
public:
    void set(const std::string& key, const std::string& value);
    bool has(const std::string& key) const;

    std::string getString(const std::string& key, const std::string& fallback) const;
    double getDouble(const std::string& key, double fallback) const;
    std::int64_t getInt(const std::string& key, std::int64_t fallback) const;
    // 쉼표로 구분된 숫자 목록. 값이 비어 있으면 빈 목록이다.
    std::vector<double> getDoubleList(const std::string& key, const std::string& fallback) const;

    std::vector<std::string> unusedKeys() const;
    const std::map<std::string, std::string>& values() const { return values_; }

private:
    const std::string* lookup(const std::string& key) const;

    std::map<std::string, std::string> values_;
    mutable std::set<std::string> used_;
};

// "key=value"를 나눈다. 형식이 틀리면 std::invalid_argument.
std::pair<std::string, std::string> parseAssignment(std::string_view text);
// 한 줄에 key=value 하나, '#' 뒤는 주석.
void loadParamsFile(const std::filesystem::path& path, Params& params);

std::string_view trim(std::string_view text);
std::vector<std::string_view> split(std::string_view text, char sep);
double parseDouble(std::string_view text, std::string_view context);
std::int64_t parseInt(std::string_view text, std::string_view context);

}  // namespace lb::gen
