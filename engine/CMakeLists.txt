# strategies/ 아래 파일은 자동으로 포함된다. 새 전략은 파일을 추가한 뒤
# strategies/builtin.hpp에 선언하고 makeBuiltinStrategies()에 등록하면 된다.
file(GLOB LB_ENGINE_STRATEGIES CONFIGURE_DEPENDS src/strategies/*.cpp)

add_library(lb_engine_core STATIC
    src/result_writer.cpp
    src/server_spec.cpp
    src/simulation.cpp
    ${LB_ENGINE_STRATEGIES}
)
target_include_directories(lb_engine_core PUBLIC src)
target_link_libraries(lb_engine_core PUBLIC lb_common)

add_executable(lb_simulator src/main.cpp)
target_link_libraries(lb_simulator PRIVATE lb_engine_core)

add_executable(lb_engine_tests tests/engine_tests.cpp)
target_link_libraries(lb_engine_tests PRIVATE lb_engine_core)
add_test(NAME lb_engine_tests COMMAND lb_engine_tests)
