#include "lb/params.hpp"

#include <charconv>
#include <cmath>
#include <fstream>
#include <stdexcept>

namespace lb {

void Params::set(const std::string& key, const std::string& value) { values_[key] = value; }

bool Params::has(const std::string& key) const { return values_.count(key) > 0; }

const std::string* Params::lookup(const std::string& key) const {
    used_.insert(key);
    const auto it = values_.find(key);
    return it == values_.end() ? nullptr : &it->second;
}

std::string Params::getString(const std::string& key, const std::string& fallback) const {
    const std::string* value = lookup(key);
    return value ? *value : fallback;
}

double Params::getDouble(const std::string& key, double fallback) const {
    const std::string* value = lookup(key);
    return value ? parseDouble(*value, key) : fallback;
}

std::int64_t Params::getInt(const std::string& key, std::int64_t fallback) const {
    const std::string* value = lookup(key);
    return value ? parseInt(*value, key) : fallback;
}

std::vector<double> Params::getDoubleList(const std::string& key, const std::string& fallback) const {
    const std::string* value = lookup(key);
    const std::string_view text = trim(value ? *value : fallback);
    std::vector<double> result;
    if (text.empty()) return result;
    for (std::string_view item : split(text, ',')) result.push_back(parseDouble(item, key));
    return result;
}

std::vector<std::string> Params::unusedKeys() const {
    std::vector<std::string> unused;
    for (const auto& [key, value] : values_) {
        if (!used_.count(key)) unused.push_back(key);
    }
    return unused;
}

CommandLine parseCommandLine(int argc, const char* const* argv) {
    CommandLine command;
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            command.help = true;
        } else if (arg == "--list") {
            command.list = true;
        } else if (arg == "--config") {
            if (++i >= argc) throw std::invalid_argument("--config 뒤에 파일 경로가 필요하다");
            loadParamsFile(argv[i], command.params);
        } else {
            auto [key, value] = parseAssignment(arg);
            command.params.set(key, value);
        }
    }
    return command;
}

void rejectUnusedKeys(const Params& params, std::string_view owner) {
    const auto unused = params.unusedKeys();
    if (unused.empty()) return;
    std::string keys;
    for (const std::string& key : unused) keys += ' ' + key;
    throw std::invalid_argument(std::string(owner) + "에서 쓰지 않는 파라미터:" + keys);
}

std::pair<std::string, std::string> parseAssignment(std::string_view text) {
    const auto eq = text.find('=');
    const std::string_view key = trim(text.substr(0, eq));
    if (eq == std::string_view::npos || key.empty()) {
        throw std::invalid_argument("key=value 형식이 아니다: '" + std::string(text) + "'");
    }
    return {std::string(key), std::string(trim(text.substr(eq + 1)))};
}

void loadParamsFile(const std::filesystem::path& path, Params& params) {
    std::ifstream in(path);
    if (!in) throw std::runtime_error("설정 파일을 열 수 없다: " + path.string());
    std::string line;
    while (std::getline(in, line)) {
        std::string_view content = line;
        content = trim(content.substr(0, content.find('#')));
        if (content.empty()) continue;
        auto [key, value] = parseAssignment(content);
        params.set(key, value);
    }
}

std::string_view trim(std::string_view text) {
    constexpr std::string_view kSpace = " \t\r\n";
    const auto begin = text.find_first_not_of(kSpace);
    if (begin == std::string_view::npos) return {};
    const auto end = text.find_last_not_of(kSpace);
    return text.substr(begin, end - begin + 1);
}

std::vector<std::string_view> split(std::string_view text, char sep) {
    std::vector<std::string_view> parts;
    std::size_t start = 0;
    while (true) {
        const auto pos = text.find(sep, start);
        parts.push_back(trim(text.substr(start, pos - start)));
        if (pos == std::string_view::npos) break;
        start = pos + 1;
    }
    return parts;
}

double parseDouble(std::string_view text, std::string_view context) {
    text = trim(text);
    double value{};
    const auto* end = text.data() + text.size();
    auto [ptr, ec] = std::from_chars(text.data(), end, value);
    if (ec != std::errc{} || ptr != end || !std::isfinite(value)) {
        throw std::invalid_argument(std::string(context) + ": 숫자가 아니다: '" + std::string(text) + "'");
    }
    return value;
}

std::int64_t parseInt(std::string_view text, std::string_view context) {
    text = trim(text);
    std::int64_t value{};
    const auto* end = text.data() + text.size();
    auto [ptr, ec] = std::from_chars(text.data(), end, value);
    if (ec != std::errc{} || ptr != end) {
        throw std::invalid_argument(std::string(context) + ": 정수가 아니다: '" + std::string(text) + "'");
    }
    return value;
}

}  // namespace lb
