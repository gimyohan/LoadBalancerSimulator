# scenarios/ 아래 파일은 자동으로 포함된다. 새 시나리오는 파일을 추가한 뒤
# scenarios/builtin.hpp에 선언하고 makeBuiltinRegistry()에 등록하면 된다.
file(GLOB LB_GENERATOR_SCENARIOS CONFIGURE_DEPENDS src/scenarios/*.cpp)

add_library(lb_generator_core STATIC
    src/distribution.cpp
    src/event_builder.cpp
    src/params.cpp
    src/random.cpp
    src/scenario.cpp
    src/scenario_registry.cpp
    ${LB_GENERATOR_SCENARIOS}
)
target_include_directories(lb_generator_core PUBLIC src)
target_link_libraries(lb_generator_core PUBLIC lb_common)

add_executable(lb_generator src/main.cpp)
target_link_libraries(lb_generator PRIVATE lb_generator_core)

add_executable(lb_generator_tests tests/generator_tests.cpp)
target_link_libraries(lb_generator_tests PRIVATE lb_generator_core)
add_test(NAME lb_generator_tests COMMAND lb_generator_tests)
