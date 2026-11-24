# Native build: a standalone app plus VST3 and (on macOS) AU plugins.
#
# The interface is the web app, embedded and shown in a WebView, so build it
# first from the repository root:
#
#   npm install && npm run build:native
#   cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
#   cmake --build native/build --config Release

cmake_minimum_required(VERSION 3.22)

set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Build a universal binary on macOS")

project(SteamControllerMIDI VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

option(SCM_BUILD_TESTS "Build the parity test for the C++ engine" ON)

include(FetchContent)

FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.15
    GIT_SHALLOW TRUE)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(HIDAPI_WITH_LIBUSB OFF CACHE BOOL "" FORCE)
set(HIDAPI_BUILD_HIDTEST OFF CACHE BOOL "" FORCE)
FetchContent_Declare(hidapi
    GIT_REPOSITORY https://github.com/libusb/hidapi.git
    GIT_TAG hidapi-0.16.0
    GIT_SHALLOW TRUE)

FetchContent_MakeAvailable(JUCE hidapi)

# ---- the engine on its own (no JUCE), plus its test ----
add_library(scm_core STATIC Source/Core.cpp)
target_include_directories(scm_core PUBLIC Source)
# The engine must round exactly like the JavaScript version (the parity test
# checks this). Fusing a multiply and an add into one FMA instruction, which
# compilers do by default on Apple Silicon and other FMA-capable targets,
# changes the last bit of some results and so occasionally a MIDI value.
target_compile_options(scm_core PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/fp:precise>
    $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-ffp-contract=off>)

if(SCM_BUILD_TESTS)
    enable_testing()
    add_executable(scm_parity Tests/parity.cpp)
    target_link_libraries(scm_parity PRIVATE scm_core)
    # fixtures.txt comes from `npm run fixtures`
    add_test(NAME parity COMMAND scm_parity ${CMAKE_CURRENT_SOURCE_DIR}/Tests/fixtures.txt)
endif()

# ---- the embedded web interface ----
set(SCM_WEB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../dist)
file(GLOB SCM_WEB_FILES CONFIGURE_DEPENDS ${SCM_WEB_DIR}/*.* ${SCM_WEB_DIR}/assets/*.*)
set(SCM_DEFAULT_CONFIG ${CMAKE_CURRENT_SOURCE_DIR}/Resources/default-config.json)
if(NOT EXISTS ${SCM_WEB_DIR}/index.html OR NOT EXISTS ${SCM_DEFAULT_CONFIG})
    message(FATAL_ERROR "The web interface has not been built. Run `npm install && npm run build:native` in the repository root first.")
endif()
juce_add_binary_data(scm_web SOURCES ${SCM_WEB_FILES} ${SCM_DEFAULT_CONFIG})
set_target_properties(scm_web PROPERTIES POSITION_INDEPENDENT_CODE ON)

set(SCM_SOURCES
    Source/Config.cpp
    Source/Hub.cpp
    Source/PluginEditor.cpp
    Source/PluginProcessor.cpp)

function(scm_configure target)
    target_sources(${target} PRIVATE ${SCM_SOURCES})
    target_compile_definitions(${target} PUBLIC
        JUCE_WEB_BROWSER=1
        JUCE_USE_CURL=0
        JUCE_VST3_CAN_REPLACE_VST2=0
        JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
        JUCE_DISPLAY_SPLASH_SCREEN=0)
    target_link_libraries(${target}
        PRIVATE
            scm_core
            scm_web
            hidapi::hidapi
            juce::juce_audio_utils
            juce::juce_gui_extra
        PUBLIC
            juce::juce_recommended_config_flags
            juce::juce_recommended_lto_flags)
endfunction()

# Standalone app and VST3. Declared as an instrument with MIDI output: that is
# what Ableton Live needs in order to route a plugin's MIDI to other tracks.
juce_add_plugin(SteamControllerMIDI
    PRODUCT_NAME "Steam Controller MIDI"
    COMPANY_NAME "Steam Controller MIDI"
    BUNDLE_ID com.steamcontrollermidi.app
    PLUGIN_MANUFACTURER_CODE Scmi
    PLUGIN_CODE Scm1
    FORMATS Standalone VST3
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    VST3_CATEGORIES Instrument
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    NEEDS_CURL FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE)
scm_configure(SteamControllerMIDI)

# Audio Unit, as a MIDI effect: the only AU type whose MIDI output hosts such
# as Logic pass on. (Ableton Live does not take MIDI from AUs at all; use the
# VST3 there.)
if(APPLE)
    juce_add_plugin(SteamControllerMIDI_AU
        PRODUCT_NAME "Steam Controller MIDI"
        COMPANY_NAME "Steam Controller MIDI"
        BUNDLE_ID com.steamcontrollermidi.au
        PLUGIN_MANUFACTURER_CODE Scmi
        PLUGIN_CODE Scm2
        FORMATS AU
        IS_SYNTH FALSE
        NEEDS_MIDI_INPUT TRUE
        NEEDS_MIDI_OUTPUT TRUE
        IS_MIDI_EFFECT TRUE
        EDITOR_WANTS_KEYBOARD_FOCUS TRUE
        NEEDS_WEB_BROWSER TRUE
        NEEDS_CURL FALSE
        COPY_PLUGIN_AFTER_BUILD FALSE)
    scm_configure(SteamControllerMIDI_AU)
endif()
