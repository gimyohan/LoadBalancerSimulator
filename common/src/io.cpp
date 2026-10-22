#include "lb/io.hpp"

#include <stdexcept>

namespace lb {

std::string csvField(std::string_view text) {
    if (text.find_first_of(",\"\r\n") == std::string_view::npos) return std::string(text);
    std::string quoted = "\"";
    for (char c : text) {
        if (c == '"') quoted += '"';
        quoted += c;
    }
    return quoted + '"';
}

std::ofstream openOutputFile(const std::filesystem::path& path) {
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    if (!out) throw std::runtime_error("출력 파일을 열 수 없다: " + path.string());
    return out;
}

void closeOutputFile(std::ofstream& out, const std::filesystem::path& path) {
    out.close();
    if (!out) throw std::runtime_error("출력 파일 쓰기 실패: " + path.string());
}

}  // namespace lb
