cmake_minimum_required(VERSION 3.15)
project(BridgeCamFilter LANGUAGES CXX)

# Simple DirectShow filter build; expects Windows SDK.
# A real implementation will require linking against strmiids.lib and quartz.lib.

# The driver code in BridgeCamFilter.cpp requires the DirectShow "Base
# Classes" headers (streams.h etc.) which are not part of the standard
# Windows SDK.  For now we supply minimal stubs directly in the source so
# the filter builds successfully.  When a proper build environment is
# available we can swap back to the real base classes.
#
add_library(BridgeCamFilter SHARED BridgeCamFilter.cpp BridgeCamMFSource.cpp)
# link definition file ensures DllRegisterServer and DllUnregisterServer are
# exported by name so regsvr32 can call them.
target_link_options(BridgeCamFilter PRIVATE "/DEF:${CMAKE_CURRENT_SOURCE_DIR}/BridgeCamFilter.def")

target_compile_features(BridgeCamFilter PRIVATE cxx_std_17)

# The source registers COM directly and does not require the SDK sample base classes.
target_link_libraries(BridgeCamFilter PRIVATE strmiids quartz mfplat mfuuid propsys ksproxy mfsensorgroup)

# Utility for testing shared memory reads
add_executable(frame_reader frame_reader.cpp)
add_executable(frame_writer frame_writer.cpp)
target_compile_features(frame_reader PRIVATE cxx_std_17)

# Enumeration helper to list installed video capture devices (used to verify
# that the filter registers correctly).  Builds against the same DirectShow
# libraries as the filter itself.
add_executable(enum_devices enum_devices.cpp)
target_compile_features(enum_devices PRIVATE cxx_std_17)
target_link_libraries(enum_devices PRIVATE strmiids)

# Media Foundation enumerator — lists same cameras seen by NVB / Teams / Zoom.
add_executable(enum_mf_devices enum_mf_devices.cpp)
target_compile_features(enum_mf_devices PRIVATE cxx_std_17)
target_link_libraries(enum_mf_devices PRIVATE mf mfplat ole32)

# Standalone MFCreateVirtualCamera test — prints exact HRESULTs from Create + Start
add_executable(test_vcam test_vcam.cpp)
target_compile_features(test_vcam PRIVATE cxx_std_17)
target_link_libraries(test_vcam PRIVATE mfsensorgroup mfplat mf ole32)

# External consumer test: opens published BridgeCam source without creating it
add_executable(test_vcam_external test_vcam_external.cpp)
target_compile_features(test_vcam_external PRIVATE cxx_std_17)
target_link_libraries(test_vcam_external PRIVATE mfsensorgroup mfplat mf ole32 mfuuid)

# IMFSourceReader smoke test — opens BridgeCam, reads frames, checks for non-black pixels
add_executable(test_reader test_reader.cpp)
target_compile_features(test_reader PRIVATE cxx_std_17)
target_link_libraries(test_reader PRIVATE mfplat mfreadwrite mf mfuuid ole32)

# Installation commands will be added when the driver is ready.
