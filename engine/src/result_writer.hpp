#pragma once

#include <filesystem>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "simulation.hpp"

namespace lb::sim {

// 결과와 함께 기록할 실행 설정.
struct RunInfo {
    std::string strategy;
    std::string strategy_description;  // StrategyInfo::description
    // 전략이 받는 파라미터와 이번 실행에 적용된 값 (지정하지 않았으면 기본값)
    std::vector<std::pair<std::string, std::string>> strategy_params;
    std::string events_file;
    std::string servers_spec;
    std::map<std::string, std::string> params;  // 명령행에서 받은 전체 파라미터
};

// directory 아래에 결과 CSV를 쓴다.
//   summary.csv      metric,value  (지표와 실행 설정)
//   servers.csv      서버별 크기, 수락 세션, 최대/평균 사용량과 이용률, 포화 시간, 사용량 몫과 용량 몫
//   timeline.csv     시각별 사용량 스냅샷 (load_<id> 열이 서버별 사용량)
//   assignments.csv  연결 요청별 처리 결과, 거절 원인, 선택 소요 시간, 조회 수
//   violations.csv   전략의 잘못된 행동 내역
//   weight_classes.csv  가중치 구간(1, 2–3, 4–7, ...)별 요청·거절 수
void writeResults(const std::filesystem::path& directory, const RunInfo& info, const SimulationResult& result);

}  // namespace lb::sim
