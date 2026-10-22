add_library(lb_common STATIC
    src/console.cpp
    src/event.cpp
    src/io.cpp
    src/params.cpp
    src/random.cpp
    src/registry.cpp
)
target_include_directories(lb_common PUBLIC include)
