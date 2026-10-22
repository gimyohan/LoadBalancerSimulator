cmake_minimum_required(VERSION 3.20)
project(LoadBalancingSimulation LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

if(MSVC)
    add_compile_options(/W4 /utf-8 /permissive-)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# MinGW 런타임 DLL 없이 실행 파일만으로 돌 수 있게 한다.
if(MINGW)
    add_link_options(-static)
endif()

enable_testing()

add_subdirectory(common)
add_subdirectory(generator)
