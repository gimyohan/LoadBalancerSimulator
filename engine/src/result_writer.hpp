#pragma once

#include <filesystem>
#include <map>
#include <string>

#include "simulation.hpp"

namespace lb::sim {

// 결과와 함께 기록할 실행 설정.
struct RunInfo {
    std::string strategy;
    std::string events_file;
    std::string servers_spec;
    std::map<std::string, std::string> params;  // 명령행에서 받은 전체 파라미터
};

// directory 아래에 결과 CSV를 쓴다.
//   summary.csv      metric,value  (지표와 실행 설정)
//   servers.csv      서버별 크기, 수락 세션 수, 최대/평균 사용량과 이용률
//   timeline.csv     시각별 사용량 스냅샷 (load_<id> 열이 서버별 사용량)
//   assignments.csv  연결 요청별 처리 결과와 서버 선택 소요 시간
//   violations.csv   전략의 잘못된 행동 내역
void writeResults(const std::filesystem::path& directory, const RunInfo& info, const SimulationResult& result);

}  // namespace lb::sim
