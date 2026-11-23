cmake_minimum_required(VERSION 3.20)
project(BridgeCamExtension LANGUAGES C)

# This is placeholder CMake; actual macOS camera extension build must use
# Xcode with appropriate entitlements and CoreMediaIO framework.

add_library(BridgeCamExtension MODULE BridgeCamExtension.m)

find_library(COREMEDIAIO CoreMediaIO)

target_link_libraries(BridgeCamExtension PRIVATE ${COREMEDIAIO})

target_compile_options(BridgeCamExtension PRIVATE -fobjc-arc)

# Code signing and entitlements will need to be configured separately.