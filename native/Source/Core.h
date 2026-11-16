// Controller protocol and mapping engine. Plain C++17 with no JUCE, so it can
// be unit-tested on its own. This is a port of src/core/*.ts and must behave
// identically: Tests/parity.cpp replays fixtures generated from the
// TypeScript version.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace scm
{

constexpr int kNumButtons = 30;
constexpr int kNumAxes = 18;

struct ButtonDef
{
    const char* id;
    uint32_t mask;
};

struct AxisDef
{
    const char* id;
    bool bipolar;
    /** index of the button that must be down for the axis to count, or -1 */
    int activeWhile;
};

/** Same order as BUTTONS / AXES in src/core/inputs.ts. */
extern const std::array<ButtonDef, kNumButtons> kButtons;
extern const std::array<AxisDef, kNumAxes> kAxes;

enum Axis
{
    kLT, kRT,
    kLStickX, kLStickY, kRStickX, kRStickY,
    kLPadX, kLPadY, kLPadPressure, kRPadX, kRPadY, kRPadPressure,
    kTiltPitch, kTiltRoll, kTurn, kGyroX, kGyroY, kGyroZ,
};

/** Index into kButtons / kAxes for an input id, or -1. */
int buttonIndex (const std::string& id);
int axisIndex (const std::string& id);

struct ControllerState
{
    std::array<bool, kNumButtons> buttons {};
    std::array<double, kNumAxes> axes {};

    /** Buttons packed with the controller's own bit masks (for sending to the UI). */
    uint32_t buttonMask() const;
};

// ---------------------------------------------------------------- protocol

constexpr uint16_t kValveVid = 0x28de;
constexpr uint16_t kPidWired = 0x1302;
constexpr uint16_t kPidBle = 0x1303;
constexpr uint16_t kPidPuck = 0x1304;
constexpr uint16_t kPidPuck2 = 0x1305;

inline bool isTritonPid (uint16_t pid)
{
    return pid == kPidWired || pid == kPidBle || pid == kPidPuck || pid == kPidPuck2;
}

struct TritonContext
{
    bool hasImuTs = false;
    uint32_t lastImuTs = 0;
    double yaw = 0;
    double ax = 0, ay = 0, az = 1;
    bool accelPrimed = false;
    double pitchZero = 0, rollZero = 0;
    double rawPitch = 0, rawRoll = 0;

    /** Make the current orientation the centre for tilt and yaw. */
    void recenter()
    {
        pitchZero = rawPitch;
        rollZero = rawRoll;
        yaw = 0;
    }
};

struct ParsedReport
{
    enum Type { unknown, state, battery, wireless } type = unknown;
    int batteryLevel = 0;
    bool charging = false;
    bool connected = false;
};

/**
 * Parse one input report. `data` is the payload *without* the leading
 * report-id byte. Never throws; short or unrecognised reports are `unknown`.
 */
ParsedReport parseReport (uint8_t reportId, const uint8_t* data, size_t size,
                          ControllerState& state, TritonContext& ctx);

constexpr int kMaintenanceIntervalMs = 2000;
constexpr uint8_t kFeatureReportId = 1;

/**
 * The 64-byte feature report (report id first) that turns off the built-in
 * mouse/keyboard emulation and turns the motion sensors on. The controller
 * reverts by itself after a few seconds, so it has to be re-sent.
 */
std::array<uint8_t, 64> buildSettingsReport (bool enableImu = true);

// ----------------------------------------------------------------- mapping

enum class MappingType { note, cc, pitchbend, relative };

struct Mapping
{
    std::string id;
    /** index into kButtons when isAxis is false, else into kAxes */
    int input = 0;
    bool isAxis = false;
    bool enabled = true;
    MappingType type = MappingType::note;
    int channel = 1;
    int note = 60;
    int velocity = 100;
    int cc = 1;
    int min = 0;
    int max = 127;
    bool toggle = false;
    int grid = 0;
    double speed = 64;
    bool invert = false;
    double deadzone = 0;
    double curve = 1;
    double smooth = 0;
    double threshold = 0.5;
    /** button index, or -1 for "always active" */
    int gate = -1;
    bool releaseReset = false;

    bool operator== (const Mapping& o) const;
};

struct MidiMessage
{
    uint8_t bytes[3];
    bool operator== (const MidiMessage& o) const
    {
        return bytes[0] == o.bytes[0] && bytes[1] == o.bytes[1] && bytes[2] == o.bytes[2];
    }
};

using MidiList = std::vector<MidiMessage>;

class Engine
{
public:
    /** Replace the active mappings; appends note-offs for anything that changed or went away. */
    void setMappings (const std::vector<Mapping>& mappings, MidiList& out);

    /** Stop every sounding note. */
    void releaseAll (MidiList& out);

    /**
     * Feed one controller snapshot and append the MIDI to send.
     * `solo` is a mapping id, or empty for none. `nowMs` < 0 assumes the
     * controller's 250 Hz report rate.
     */
    void process (const ControllerState& state, const std::string& solo, double nowMs, MidiList& out);

private:
    struct Runtime
    {
        Mapping mapping;
        bool pressed = false;
        bool on = false;
        bool hasHeld = false;
        int heldCh = 0, heldNote = 0;
        int last = -1;
        bool hasSmoothed = false;
        double smoothed = 0;
        bool active = false;
        double acc = 0;
        bool hasPrevT = false;
        double prevT = 0;
    };

    void release (Runtime&, MidiList&);
    void setOn (Runtime&, bool on, MidiList&, int noteOffset = 0);
    void processButton (Runtime&, const ControllerState&, bool live, MidiList&);
    void processAxis (Runtime&, const ControllerState&, bool live, MidiList&);
    void sendPosition (Runtime&, double t, MidiList&);

    std::vector<Runtime> runtimes;
    bool hasLastNow = false;
    double lastNow = 0;
    double dt = 0;
};

/** Messages that identify a mapping to a DAW's MIDI learn, with delays in ms. */
struct LearnStep
{
    int delayMs;
    MidiMessage message;
};
std::vector<LearnStep> learnMessages (const Mapping&);

} // namespace scm
