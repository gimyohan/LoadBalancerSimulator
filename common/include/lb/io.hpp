#pragma once

#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>

namespace lb {

// CSV 필드 하나. 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다.
std::string csvField(std::string_view text);

// 상위 디렉터리를 만들고 파일을 쓰기용으로 연다. 열지 못하면 std::runtime_error.
std::ofstream openOutputFile(const std::filesystem::path& path);
// 쓰기를 마무리한다. 실패하면 std::runtime_error.
void closeOutputFile(std::ofstream& out, const std::filesystem::path& path);

}  // namespace lb
