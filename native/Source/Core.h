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

/**
 * Button debounce: an edge is passed on immediately, then that button ignores
 * further changes for a short window, so contact chatter can't double a note.
 * Mirrors src/core/debounce.ts.
 */
class Debouncer
{
public:
    static constexpr double kWindowMs = 20.0;

    void apply (ControllerState& state, double nowMs)
    {
        for (size_t i = 0; i < (size_t) kNumButtons; ++i)
        {
            const bool raw = state.buttons[i];
            if (raw != stable[i] && nowMs - changedAt[i] >= kWindowMs)
            {
                stable[i] = raw;
                changedAt[i] = nowMs;
            }
            else
            {
                state.buttons[i] = stable[i];
            }
        }
    }

    void reset()
    {
        stable.fill (false);
        changedAt.fill (-1e18);
    }

private:
    std::array<bool, kNumButtons> stable {};
    std::array<double, kNumButtons> changedAt = makeNever();

    static std::array<double, kNumButtons> makeNever()
    {
        std::array<double, kNumButtons> a {};
        a.fill (-1e18);
        return a;
    }
};

constexpr int kMaintenanceIntervalMs = 2000;
constexpr uint8_t kFeatureReportId = 1;

/**
 * The 64-byte feature report (report id first) that turns off the built-in
 * mouse/keyboard emulation and turns the motion sensors on. The controller
 * reverts by itself after a few seconds, so it has to be re-sent.
 */
std::array<uint8_t, 64> buildSettingsReport (bool enableImu = true);

constexpr uint8_t kRumbleReportId = 0x80;

/**
 * Payload (without the report id) of the rumble output report, as SDL sends
 * it: { u8 type; u16 intensity; { u16 speed; i8 gain } left, right }. The
 * controller stops on its own about 50 ms after the last one, so a single
 * report makes a short tap. Mirrors buildRumbleReport in src/core/triton.ts.
 */
std::array<uint8_t, 9> buildRumbleReport (double left, double right);

// ------------------------------------------------------------------ scales

struct Scale
{
    const char* id;
    std::vector<int> steps;
};

constexpr int kNumScales = 11;

/** Same order as SCALES in src/core/scales.ts: presets and the engine refer to scales by index. */
extern const std::array<Scale, kNumScales> kScales;

/** Index into kScales for a scale id; unknown ids are chromatic (0). */
int scaleIndex (const std::string& id);

/** The nearest note in the scale at or above `n` (or the highest below, at the top of the range). */
int quantizeNote (int n, int root, int scale);

/** The note `degrees` scale steps above `base` (which should already be in the scale); at most the highest in-scale note. */
int stepScale (int base, int degrees, int root, int scale);

// ----------------------------------------------------------------- mapping

enum class MappingType { note, cc, pitchbend, relative };

/** Where a note's velocity comes from (Mapping.velFrom in src/core/mapping.ts). */
enum class VelocitySource { fixed, lt, rt, lpadPressure, rpadPressure, speed };

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
    VelocitySource velFrom = VelocitySource::fixed;
    /** velocity at the bottom of the source's range */
    int velMin = 1;
    /** axes: multiplies the input before shaping */
    double gain = 1;
    /** button → note: retriggers per beat while held, 0 = off */
    int repeat = 0;
    /** notes follow the preset's scale */
    bool scale = true;
    /** trackpad click / touch → note: one MPE member channel per note */
    bool mpe = false;
    /** MPE: semitones of bend from the touch point to the pad's edge */
    int bend = 2;

    bool operator== (const Mapping& o) const;
};

struct MidiMessage
{
    /** Unused trailing bytes are 0. */
    uint8_t bytes[3];
    /** 3, or 2 for channel pressure */
    uint8_t size = 3;

    bool operator== (const MidiMessage& o) const
    {
        if (size != o.size)
            return false;
        for (int i = 0; i < size; ++i)
            if (bytes[i] != o.bytes[i])
                return false;
        return true;
    }
};

using MidiList = std::vector<MidiMessage>;

class Engine
{
public:
    /**
     * Tempo (BPM, for note repeat) and scale mode (root 0-11, index into
     * kScales, 0 = off). Clamped the same way as Engine.setOptions in TS.
     */
    void setOptions (double tempo, double scaleRoot, double scale);
    double getTempo() const { return tempo; }

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
    struct MpeVoice
    {
        int ch = 0;
        /** pad X where the finger came down; bend is relative to it */
        double x0 = 0;
        int bend = 8192;
        int y = 0;
        int pressure = 0;
    };

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
        /** note repeat: engine clock time of the next retrigger */
        bool hasNextRepeat = false;
        double nextRepeat = 0;
        bool hasMpe = false;
        MpeVoice mpe;
        /** axis → note: previous travel (for 'speed' velocity) and the velocity it gave */
        bool hasPrevTravel = false;
        double prevTravel = 0;
        int speedVel = 100;
    };

    void release (Runtime&, MidiList&);
    void freeVoice (Runtime&);
    /** `velocity` < 0 means the mapping's own velocity. */
    void setOn (Runtime&, bool on, MidiList&, int noteOffset = 0, int velocity = -1);
    int noteFor (const Mapping&, int offset) const;
    int velocityFor (const Runtime&, const ControllerState&) const;
    double repeatInterval (const Mapping&) const;
    void processButton (Runtime&, const ControllerState&, bool live, MidiList&);
    void processMpe (Runtime&, const ControllerState&, int padAxis, bool pressed, bool was, MidiList&);
    int allocateChannel();
    void processAxis (Runtime&, const ControllerState&, bool live, MidiList&);
    void sendPosition (Runtime&, double t, MidiList&);

    std::vector<Runtime> runtimes;
    bool hasLastNow = false;
    double lastNow = 0;
    double dt = 0;
    /** engine time in ms: the caller's clock, or 4 ms per call without one */
    double clock = 0;
    double tempo = 120;
    int scaleRoot = 0;
    int scale = 0;
    /** MPE member channels (2-16) in use, and where the round-robin continues */
    std::array<bool, 17> mpeBusy {};
    int mpeNext = 2;
};

/** Messages that identify a mapping to a DAW's MIDI learn, with delays in ms. */
struct LearnStep
{
    int delayMs;
    MidiMessage message;
};
std::vector<LearnStep> learnMessages (const Mapping&);

} // namespace scm
