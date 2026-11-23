#include "Core.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace scm
{

// Button masks come from SDL's SDL_hidapi_steam_triton.c (TritonButtons enum).
const std::array<ButtonDef, kNumButtons> kButtons { {
    { "a", 0x00000001 },
    { "b", 0x00000002 },
    { "x", 0x00000004 },
    { "y", 0x00000008 },
    { "dpad_up", 0x00002000 },
    { "dpad_down", 0x00000400 },
    { "dpad_left", 0x00001000 },
    { "dpad_right", 0x00000800 },
    { "lb", 0x00080000 },
    { "rb", 0x00000200 },
    { "lt_click", 0x08000000 },
    { "rt_click", 0x00800000 },
    { "l3", 0x00008000 },
    { "r3", 0x00000020 },
    { "lstick_touch", 0x01000000 },
    { "rstick_touch", 0x00100000 },
    { "lpad_touch", 0x02000000 },
    { "lpad_click", 0x04000000 },
    { "rpad_touch", 0x00200000 },
    { "rpad_click", 0x00400000 },
    { "l4", 0x00020000 },
    { "l5", 0x00040000 },
    { "r4", 0x00000080 },
    { "r5", 0x00000100 },
    { "lgrip_touch", 0x20000000 },
    { "rgrip_touch", 0x10000000 },
    { "view", 0x00000040 },
    { "menu", 0x00004000 },
    { "steam", 0x00010000 },
    { "qam", 0x00000010 },
} };

namespace
{
constexpr int kLPadTouch = 16;
constexpr int kRPadTouch = 18;
constexpr int kLPadClick = 17;
constexpr int kRPadClick = 19;
}

const std::array<AxisDef, kNumAxes> kAxes { {
    { "lt", false, -1 },
    { "rt", false, -1 },
    { "lstick_x", true, -1 },
    { "lstick_y", true, -1 },
    { "rstick_x", true, -1 },
    { "rstick_y", true, -1 },
    { "lpad_x", true, kLPadTouch },
    { "lpad_y", true, kLPadTouch },
    { "lpad_pressure", false, -1 },
    { "rpad_x", true, kRPadTouch },
    { "rpad_y", true, kRPadTouch },
    { "rpad_pressure", false, -1 },
    { "tilt_pitch", true, -1 },
    { "tilt_roll", true, -1 },
    { "turn", true, -1 },
    { "gyro_x", true, -1 },
    { "gyro_y", true, -1 },
    { "gyro_z", true, -1 },
} };

int buttonIndex (const std::string& id)
{
    for (int i = 0; i < kNumButtons; ++i)
        if (id == kButtons[(size_t) i].id)
            return i;
    return -1;
}

int axisIndex (const std::string& id)
{
    for (int i = 0; i < kNumAxes; ++i)
        if (id == kAxes[(size_t) i].id)
            return i;
    return -1;
}

uint32_t ControllerState::buttonMask() const
{
    uint32_t m = 0;
    for (size_t i = 0; i < (size_t) kNumButtons; ++i)
        if (buttons[i])
            m |= kButtons[i].mask;
    return m;
}

// ---------------------------------------------------------------- protocol

namespace
{
struct Layout
{
    int buttons, triggerL, triggerR, lsx, lsy, rsx, rsy;
    int lpx, lpy, lpp, rpx, rpy, rpp;
    int imuTs, imuTsBytes, imuTsUs, accel, gyro;
};

// TritonMTUNoQuat_t (reports 0x42 and 0x45). Offsets exclude the report id.
constexpr Layout kLayoutStd { 1, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 4, 1, 33, 39 };
// TritonMTUNoQuat32TS_t (report 0x47): a uint16 trackpad timestamp precedes the
// pads and the IMU timestamp is a uint16 in 32 µs units.
constexpr Layout kLayoutTs { 1, 5, 7, 9, 11, 13, 15, 19, 21, 23, 25, 27, 29, 31, 2, 32, 33, 39 };

constexpr size_t kStateReportBytes = 45;

constexpr double kGyroFullScaleDps = 2000.0;
constexpr double kGyroRateRangeDps = 360.0;
constexpr double kYawRangeDeg = 90.0;
constexpr double kGyroDeadbandDps = 1.5;
constexpr double kAccelFullScaleG = 2.0;
constexpr double kAccelSmooth = 0.15;
constexpr double kHalfPi = 1.57079632679489661923;

inline uint16_t u16 (const uint8_t* d, int off) { return (uint16_t) (d[off] | (d[off + 1] << 8)); }
inline int16_t i16 (const uint8_t* d, int off) { return (int16_t) u16 (d, off); }
inline uint32_t u32 (const uint8_t* d, int off)
{
    return (uint32_t) d[off] | ((uint32_t) d[off + 1] << 8) | ((uint32_t) d[off + 2] << 16) | ((uint32_t) d[off + 3] << 24);
}
inline double clampd (double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

void parseState (const uint8_t* d, const Layout& l, ControllerState& state, TritonContext& ctx)
{
    const uint32_t buttons = u32 (d, l.buttons);
    for (size_t i = 0; i < (size_t) kNumButtons; ++i)
        state.buttons[i] = (buttons & kButtons[i].mask) != 0;

    auto& ax = state.axes;
    ax[kLT] = clampd (i16 (d, l.triggerL) / 32767.0, 0, 1);
    ax[kRT] = clampd (i16 (d, l.triggerR) / 32767.0, 0, 1);

    auto stick = [d] (int off) { return clampd (i16 (d, off) / 32767.0, -1, 1); };
    ax[kLStickX] = stick (l.lsx);
    ax[kLStickY] = stick (l.lsy);
    ax[kRStickX] = stick (l.rsx);
    ax[kRStickY] = stick (l.rsy);

    // Pad coordinates only update while a finger is down; they hold otherwise.
    if (state.buttons[(size_t) kLPadTouch])
    {
        ax[kLPadX] = stick (l.lpx);
        ax[kLPadY] = stick (l.lpy);
    }
    if (state.buttons[(size_t) kRPadTouch])
    {
        ax[kRPadX] = stick (l.rpx);
        ax[kRPadY] = stick (l.rpy);
    }
    ax[kLPadPressure] = clampd (u16 (d, l.lpp) / 32768.0, 0, 1);
    ax[kRPadPressure] = clampd (u16 (d, l.rpp) / 32768.0, 0, 1);

    // --- motion ---
    const uint32_t ts = l.imuTsBytes == 4 ? u32 (d, l.imuTs) : u16 (d, l.imuTs);
    double dt = 0;
    if (ctx.hasImuTs)
    {
        // Unsigned subtraction handles wraparound for both widths.
        const uint32_t delta = l.imuTsBytes == 4 ? (uint32_t) (ts - ctx.lastImuTs)
                                                 : (uint32_t) (uint16_t) (ts - ctx.lastImuTs);
        dt = ((double) delta * l.imuTsUs) / 1e6;
        // A long gap means missed reports; don't integrate across it.
        if (dt > 0.25)
            dt = 0;
    }
    ctx.hasImuTs = true;
    ctx.lastImuTs = ts;

    const double gScale = kGyroFullScaleDps / 32768.0;
    const double gx = i16 (d, l.gyro) * gScale;
    const double gy = i16 (d, l.gyro + 2) * gScale;
    const double gz = i16 (d, l.gyro + 4) * gScale;
    ax[kGyroX] = clampd (gx / kGyroRateRangeDps, -1, 1);
    ax[kGyroY] = clampd (gy / kGyroRateRangeDps, -1, 1);
    ax[kGyroZ] = clampd (gz / kGyroRateRangeDps, -1, 1);

    // Ignore sensor noise while the controller is still, so yaw doesn't creep.
    if (dt > 0 && std::abs (gz) > kGyroDeadbandDps)
        ctx.yaw = clampd (ctx.yaw + gz * dt, -kYawRangeDeg, kYawRangeDeg);
    // Raw yaw is positive anticlockwise; flip so turning right is positive.
    ax[kTurn] = -ctx.yaw / kYawRangeDeg;

    const double aScale = kAccelFullScaleG / 32768.0;
    const double rax = i16 (d, l.accel) * aScale;
    const double ray = i16 (d, l.accel + 2) * aScale;
    const double raz = i16 (d, l.accel + 4) * aScale;
    // All-zero accel means the IMU isn't reporting (yet); keep the last tilt.
    if (rax != 0 || ray != 0 || raz != 0)
    {
        if (! ctx.accelPrimed)
        {
            ctx.ax = rax;
            ctx.ay = ray;
            ctx.az = raz;
            ctx.accelPrimed = true;
        }
        else
        {
            ctx.ax += (rax - ctx.ax) * kAccelSmooth;
            ctx.ay += (ray - ctx.ay) * kAccelSmooth;
            ctx.az += (raz - ctx.az) * kAccelSmooth;
        }
        // Device axes: X right, Y away from the player, Z up out of the face.
        // Signed so tilting forward / right is positive, like stick up / right.
        ctx.rawPitch = -std::atan2 (ctx.ay, ctx.az) / kHalfPi;
        ctx.rawRoll = -std::atan2 (ctx.ax, ctx.az) / kHalfPi;
    }
    ax[kTiltPitch] = clampd (ctx.rawPitch - ctx.pitchZero, -1, 1);
    ax[kTiltRoll] = clampd (ctx.rawRoll - ctx.rollZero, -1, 1);
}
} // namespace

ParsedReport parseReport (uint8_t reportId, const uint8_t* data, size_t size,
                          ControllerState& state, TritonContext& ctx)
{
    ParsedReport r;
    switch (reportId)
    {
        case 0x42:
        case 0x45:
            if (size < kStateReportBytes) return r;
            parseState (data, kLayoutStd, state, ctx);
            r.type = ParsedReport::state;
            return r;
        case 0x47:
            if (size < kStateReportBytes) return r;
            parseState (data, kLayoutTs, state, ctx);
            r.type = ParsedReport::state;
            return r;
        case 0x43:
            if (size < 2) return r;
            r.type = ParsedReport::battery;
            // EChargeState: 2 = charging, 4 = charging done
            r.charging = data[0] == 2 || data[0] == 4;
            r.batteryLevel = data[1];
            return r;
        case 0x79:
        case 0x46:
            if (size < 1) return r;
            if (data[0] == 2) { r.type = ParsedReport::wireless; r.connected = true; }
            else if (data[0] == 1) { r.type = ParsedReport::wireless; r.connected = false; }
            return r;
        default:
            return r;
    }
}

std::array<uint8_t, 64> buildSettingsReport (bool enableImu)
{
    std::array<uint8_t, 64> buf {};
    buf[0] = kFeatureReportId;
    buf[1] = 0x87; // ID_SET_SETTINGS_VALUES
    buf[2] = (uint8_t) ((enableImu ? 2 : 1) * 3);
    buf[3] = 9; // SETTING_LIZARD_MODE
    buf[4] = 0; // LIZARD_MODE_OFF
    buf[5] = 0;
    if (enableImu)
    {
        buf[6] = 48;   // SETTING_IMU_MODE
        buf[7] = 0x18; // SEND_RAW_ACCEL | SEND_RAW_GYRO
        buf[8] = 0;
    }
    return buf;
}

namespace
{
/** JavaScript's Math.round: halves round towards +infinity. */
inline double jsRound (double v) { return std::floor (v + 0.5); }
} // namespace

std::array<uint8_t, 9> buildRumbleReport (double left, double right)
{
    std::array<uint8_t, 9> buf {};
    auto speed = [] (double x)
    {
        // DataView.setUint16 turns NaN into 0.
        const double r = jsRound (x);
        return std::isnan (r) ? (uint16_t) 0 : (uint16_t) std::min (65535.0, std::max (0.0, r));
    };
    const uint16_t l = speed (left);
    const uint16_t r = speed (right);
    buf[3] = (uint8_t) (l & 0xff);
    buf[4] = (uint8_t) (l >> 8);
    buf[6] = (uint8_t) (r & 0xff);
    buf[7] = (uint8_t) (r >> 8);
    return buf;
}

// ------------------------------------------------------------------ scales

const std::array<Scale, kNumScales> kScales { {
    { "chromatic", { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 } },
    { "major", { 0, 2, 4, 5, 7, 9, 11 } },
    { "minor", { 0, 2, 3, 5, 7, 8, 10 } },
    { "dorian", { 0, 2, 3, 5, 7, 9, 10 } },
    { "phrygian", { 0, 1, 3, 5, 7, 8, 10 } },
    { "lydian", { 0, 2, 4, 6, 7, 9, 11 } },
    { "mixolydian", { 0, 2, 4, 5, 7, 9, 10 } },
    { "harmonic_minor", { 0, 2, 3, 5, 7, 8, 11 } },
    { "major_pentatonic", { 0, 2, 4, 7, 9 } },
    { "minor_pentatonic", { 0, 3, 5, 7, 10 } },
    { "blues", { 0, 3, 5, 6, 7, 10 } },
} };

int scaleIndex (const std::string& id)
{
    for (int i = 0; i < kNumScales; ++i)
        if (id == kScales[(size_t) i].id)
            return i;
    return 0;
}

namespace
{
const std::vector<int>& stepsOf (int scale)
{
    return kScales[(size_t) (scale >= 0 && scale < kNumScales ? scale : 0)].steps;
}

bool inScale (int n, int root, const std::vector<int>& steps)
{
    const int degree = (((n - root) % 12) + 12) % 12;
    return std::find (steps.begin(), steps.end(), degree) != steps.end();
}
} // namespace

int quantizeNote (int n, int root, int scale)
{
    const auto& steps = stepsOf (scale);
    for (int k = n; k <= 127; ++k)
        if (inScale (k, root, steps)) return k;
    for (int k = n; k >= 0; --k)
        if (inScale (k, root, steps)) return k;
    return n;
}

int stepScale (int base, int degrees, int root, int scale)
{
    const auto& steps = stepsOf (scale);
    int n = base;
    for (int left = degrees; left > 0;)
    {
        ++n;
        if (n > 127) return 127;
        if (inScale (n, root, steps)) --left;
    }
    return n;
}

// ------------------------------------------------------------------ engine

bool Mapping::operator== (const Mapping& o) const
{
    return id == o.id && input == o.input && isAxis == o.isAxis && enabled == o.enabled && type == o.type
        && channel == o.channel && note == o.note && velocity == o.velocity && cc == o.cc && min == o.min
        && max == o.max && toggle == o.toggle && grid == o.grid && speed == o.speed && invert == o.invert
        && deadzone == o.deadzone && curve == o.curve && smooth == o.smooth && threshold == o.threshold
        && gate == o.gate && releaseReset == o.releaseReset && velFrom == o.velFrom && velMin == o.velMin
        && gain == o.gain && repeat == o.repeat && scale == o.scale && mpe == o.mpe && bend == o.bend;
}

namespace
{
inline MidiMessage noteOn (int ch, int note, int vel) { return { { (uint8_t) (0x90 | (ch - 1)), (uint8_t) note, (uint8_t) vel } }; }
inline MidiMessage noteOff (int ch, int note) { return { { (uint8_t) (0x80 | (ch - 1)), (uint8_t) note, 0 } }; }
inline MidiMessage controlChange (int ch, int cc, int v) { return { { (uint8_t) (0xb0 | (ch - 1)), (uint8_t) cc, (uint8_t) v } }; }
inline MidiMessage pitchBend (int ch, int v14) { return { { (uint8_t) (0xe0 | (ch - 1)), (uint8_t) (v14 & 0x7f), (uint8_t) ((v14 >> 7) & 0x7f) } }; }
inline MidiMessage channelPressure (int ch, int v) { return { { (uint8_t) (0xd0 | (ch - 1)), (uint8_t) v, 0 }, 2 }; }

inline double clamp01 (double v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/** Math.min(127, Math.max(lo, Math.round(v))) */
inline int roundClamp (double v, double lo, double hi) { return (int) std::min (hi, std::max (lo, jsRound (v))); }

/** Shape a raw axis value into a 0-1 position (0.5 = rest for bipolar axes). */
double shapeAxis (double raw, bool bipolar, const Mapping& m)
{
    const double dz = m.deadzone;
    // Gain applies before the deadzone, so the deadzone stays a fraction of
    // the amplified travel (same as the TS version).
    double t;
    if (bipolar)
    {
        const double mag = std::min (1.0, std::abs (raw) * m.gain);
        double v = mag <= dz ? 0 : (mag - dz) / (1 - dz);
        v = std::pow (clamp01 (v), m.curve);
        const double sign = raw > 0 ? 1.0 : (raw < 0 ? -1.0 : 0.0);
        t = 0.5 + (sign * v) / 2;
    }
    else
    {
        const double r = std::min (1.0, raw * m.gain);
        const double v = r <= dz ? 0 : (r - dz) / (1 - dz);
        t = std::pow (clamp01 (v), m.curve);
    }
    return m.invert ? 1 - t : t;
}

/** Full travel per second that gives full 'speed' velocity (1 / 25 s for the whole range). */
constexpr double kSpeedFullPerSec = 25;
/** MPE: member channels use the MPE default bend range of ±48 semitones. */
constexpr double kMpeBendRange = 48;

/** First axis index of the pad a click/touch button belongs to, or -1. */
int gridPadAxis (int button)
{
    if (button == kLPadClick || button == kLPadTouch) return kLPadX;
    if (button == kRPadClick || button == kRPadTouch) return kRPadX;
    return -1;
}

int gridZone (double x, double y, int grid)
{
    auto cell = [grid] (double v)
    {
        return std::min (grid - 1, std::max (0, (int) std::floor (((v + 1) / 2) * grid)));
    };
    return cell (y) * grid + cell (x);
}
} // namespace

void Engine::setOptions (double newTempo, double newRoot, double newScale)
{
    tempo = std::min (300.0, std::max (20.0, std::isfinite (newTempo) ? newTempo : 120.0));
    // Math.round(x) || 0: NaN becomes 0, infinities are clamped.
    auto index = [] (double v, double hi)
    {
        double r = jsRound (v);
        if (std::isnan (r)) r = 0;
        return (int) std::min (hi, std::max (0.0, r));
    };
    scaleRoot = index (newRoot, 11);
    scale = index (newScale, kNumScales - 1);
}

void Engine::setMappings (const std::vector<Mapping>& mappings, MidiList& out)
{
    std::vector<Runtime> next;
    next.reserve (mappings.size());
    std::vector<bool> kept (runtimes.size(), false);

    for (const auto& m : mappings)
    {
        Runtime* prev = nullptr;
        for (size_t i = 0; i < runtimes.size(); ++i)
            if (runtimes[i].mapping.id == m.id)
            {
                prev = &runtimes[i];
                kept[i] = true;
                break;
            }

        if (prev != nullptr && prev->mapping == m)
        {
            next.push_back (*prev);
            continue;
        }
        Runtime rt;
        rt.mapping = m;
        rt.speedVel = m.velocity;
        if (prev != nullptr)
        {
            release (*prev, out);
            // Carry the physical state over so editing a mapping while its
            // button is held doesn't retrigger it.
            rt.pressed = prev->pressed;
        }
        next.push_back (std::move (rt));
    }
    for (size_t i = 0; i < runtimes.size(); ++i)
        if (! kept[i])
            release (runtimes[i], out);

    runtimes = std::move (next);
}

void Engine::releaseAll (MidiList& out)
{
    for (auto& rt : runtimes)
        release (rt, out);
}

void Engine::release (Runtime& rt, MidiList& out)
{
    if (rt.hasHeld)
    {
        out.push_back (noteOff (rt.heldCh, rt.heldNote));
        rt.hasHeld = false;
    }
    freeVoice (rt);
    rt.on = false;
    rt.hasNextRepeat = false;
}

void Engine::freeVoice (Runtime& rt)
{
    if (rt.hasMpe)
    {
        mpeBusy[(size_t) rt.mpe.ch] = false;
        rt.hasMpe = false;
    }
}

void Engine::process (const ControllerState& state, const std::string& solo, double nowMs, MidiList& out)
{
    if (nowMs < 0)
    {
        dt = 0.004;
        clock += 4;
    }
    else
    {
        // A long gap (controller asleep) must not turn into a burst.
        dt = hasLastNow ? std::min (0.1, std::max (0.0, (nowMs - lastNow) / 1000.0)) : 0.0;
        hasLastNow = true;
        lastNow = nowMs;
        clock = nowMs;
    }

    for (auto& rt : runtimes)
    {
        const auto& m = rt.mapping;
        const bool live = m.enabled && (solo.empty() || solo == m.id);
        if (m.isAxis)
            processAxis (rt, state, live, out);
        else
            processButton (rt, state, live, out);
    }
}

int Engine::noteFor (const Mapping& m, int offset) const
{
    if (scale > 0 && m.scale)
    {
        const int base = quantizeNote (m.note, scaleRoot, scale);
        return offset > 0 ? stepScale (base, offset, scaleRoot, scale) : base;
    }
    return std::min (127, m.note + offset);
}

int Engine::velocityFor (const Runtime& rt, const ControllerState& state) const
{
    const auto& m = rt.mapping;
    int axis = -1;
    switch (m.velFrom)
    {
        case VelocitySource::fixed: return m.velocity;
        case VelocitySource::speed: return m.isAxis ? rt.speedVel : m.velocity;
        case VelocitySource::lt: axis = kLT; break;
        case VelocitySource::rt: axis = kRT; break;
        case VelocitySource::lpadPressure: axis = kLPadPressure; break;
        case VelocitySource::rpadPressure: axis = kRPadPressure; break;
    }
    const double v = clamp01 (state.axes[(size_t) axis]);
    return roundClamp (m.velMin + v * (m.velocity - m.velMin), 1, 127);
}

double Engine::repeatInterval (const Mapping& m) const
{
    return 60000 / tempo / m.repeat;
}

void Engine::setOn (Runtime& rt, bool on, MidiList& out, int noteOffset, int velocity)
{
    const auto& m = rt.mapping;
    if (on == rt.on)
        return;
    rt.on = on;
    if (m.type == MappingType::note)
    {
        if (on)
        {
            const int note = noteFor (m, noteOffset);
            rt.hasHeld = true;
            rt.heldCh = m.channel;
            rt.heldNote = note;
            out.push_back (noteOn (m.channel, note, velocity >= 0 ? velocity : m.velocity));
        }
        else if (rt.hasHeld)
        {
            out.push_back (noteOff (rt.heldCh, rt.heldNote));
            rt.hasHeld = false;
            freeVoice (rt);
        }
        if (! on)
            rt.hasNextRepeat = false;
    }
    else
    {
        out.push_back (controlChange (m.channel, m.cc, on ? m.max : m.min));
    }
}

void Engine::processButton (Runtime& rt, const ControllerState& state, bool live, MidiList& out)
{
    const auto& m = rt.mapping;
    const bool pressed = state.buttons[(size_t) m.input];
    const bool was = rt.pressed;
    rt.pressed = pressed;
    if (! live)
    {
        // Never leave a note hanging when a mapping is muted mid-press.
        if (rt.hasHeld)
            setOn (rt, false, out);
        // A momentary mapping can't stay "on" while muted, or the next press
        // would be swallowed as a no-op.
        else if (! m.toggle)
            rt.on = false;
        return;
    }

    const int pad = m.type == MappingType::note ? gridPadAxis (m.input) : -1;
    if (pad >= 0 && m.mpe)
    {
        processMpe (rt, state, pad, pressed, was, out);
        return;
    }

    if (pressed == was)
    {
        // Note repeat: retrigger the held note in time.
        if (pressed && rt.hasHeld && rt.hasNextRepeat && clock >= rt.nextRepeat)
        {
            out.push_back (noteOff (rt.heldCh, rt.heldNote));
            out.push_back (noteOn (rt.heldCh, rt.heldNote, velocityFor (rt, state)));
            const double interval = repeatInterval (m);
            rt.nextRepeat += interval;
            // Fell behind (a gap in reports): carry on from now rather than catch up in a burst.
            if (rt.nextRepeat <= clock)
                rt.nextRepeat = clock + interval;
        }
        return;
    }

    // Trackpad note grid: the zone under the finger at the press picks the note.
    int offset = 0;
    if (pressed && pad >= 0 && m.grid > 0)
        offset = gridZone (state.axes[(size_t) pad], state.axes[(size_t) pad + 1], m.grid);
    const int velocity = pressed ? velocityFor (rt, state) : -1;
    if (m.toggle)
    {
        if (pressed)
            setOn (rt, ! rt.on, out, offset, velocity);
    }
    else
    {
        setOn (rt, pressed, out, offset, velocity);
        if (pressed && m.type == MappingType::note && m.repeat > 0)
        {
            rt.hasNextRepeat = true;
            rt.nextRepeat = clock + repeatInterval (m);
        }
    }
}

void Engine::processMpe (Runtime& rt, const ControllerState& state, int padAxis, bool pressed, bool was, MidiList& out)
{
    const auto& m = rt.mapping;
    // The pad's axes are laid out x, y, pressure.
    const double x = state.axes[(size_t) padAxis];
    const double y = state.axes[(size_t) padAxis + 1];
    const int yVal = roundClamp (clamp01 ((y + 1) / 2) * 127, 0, 127);
    const int pVal = roundClamp (clamp01 (state.axes[(size_t) padAxis + 2]) * 127, 0, 127);

    if (pressed && ! was)
    {
        if (rt.hasHeld)
            setOn (rt, false, out);
        const int ch = allocateChannel();
        const int offset = m.grid > 0 ? gridZone (x, y, m.grid) : 0;
        const int note = noteFor (m, offset);
        // Per MPE: set the channel's expression before the note starts.
        out.push_back (pitchBend (ch, 8192));
        out.push_back (controlChange (ch, 74, yVal));
        out.push_back (channelPressure (ch, pVal));
        out.push_back (noteOn (ch, note, velocityFor (rt, state)));
        rt.on = true;
        rt.hasHeld = true;
        rt.heldCh = ch;
        rt.heldNote = note;
        rt.hasMpe = true;
        rt.mpe = { ch, x, 8192, yVal, pVal };
        return;
    }
    if (! pressed && was)
    {
        setOn (rt, false, out);
        return;
    }
    if (! pressed || ! rt.hasMpe)
        return;
    auto& v = rt.mpe;
    const int bend = roundClamp (8192 + ((x - v.x0) * m.bend * 8192) / kMpeBendRange, 0, 16383);
    if (bend != v.bend)
    {
        v.bend = bend;
        out.push_back (pitchBend (v.ch, bend));
    }
    if (yVal != v.y)
    {
        v.y = yVal;
        out.push_back (controlChange (v.ch, 74, yVal));
    }
    if (pVal != v.pressure)
    {
        v.pressure = pVal;
        out.push_back (channelPressure (v.ch, pVal));
    }
}

int Engine::allocateChannel()
{
    // Round-robin over member channels 2-16, so a released note's tail isn't
    // cut off by the next one.
    for (int k = 0; k < 15; ++k)
    {
        const int ch = 2 + ((mpeNext - 2 + k) % 15);
        if (! mpeBusy[(size_t) ch])
        {
            mpeBusy[(size_t) ch] = true;
            mpeNext = 2 + ((ch - 2 + 1) % 15);
            return ch;
        }
    }
    // All fifteen in use (can't happen with two pads): share the next one.
    const int ch = mpeNext;
    mpeNext = 2 + ((ch - 2 + 1) % 15);
    return ch;
}

void Engine::processAxis (Runtime& rt, const ControllerState& state, bool live, MidiList& out)
{
    const auto& m = rt.mapping;
    const auto& def = kAxes[(size_t) m.input];
    const bool active = live
        && (def.activeWhile < 0 || state.buttons[(size_t) def.activeWhile])
        && (m.gate < 0 || state.buttons[(size_t) m.gate]);

    if (! active)
    {
        if (rt.active)
        {
            rt.active = false;
            rt.hasSmoothed = false;
            rt.acc = 0;
            rt.hasPrevT = false;
            rt.hasPrevTravel = false;
            if (m.type == MappingType::relative)
            {
                // an encoder has no position to hold or reset
            }
            else if (m.type == MappingType::note)
            {
                rt.pressed = false;
                setOn (rt, false, out);
            }
            else if (m.releaseReset && live)
            {
                sendPosition (rt, shapeAxis (0, def.bipolar, m), out);
            }
        }
        else if (rt.hasHeld)
        {
            setOn (rt, false, out);
        }
        return;
    }
    rt.active = true;

    const double target = shapeAxis (state.axes[(size_t) m.input], def.bipolar, m);
    double t = target;
    if (m.smooth > 0 && rt.hasSmoothed)
    {
        t = rt.smoothed + (target - rt.smoothed) * (1 - m.smooth);
        // The filter stalls a few ulps short of its target, which from below
        // rounds the centre to 8191 (or CC 63) for good. Land on it exactly.
        if (std::abs (target - t) < 1e-6)
            t = target;
    }
    rt.smoothed = t;
    rt.hasSmoothed = true;

    if (m.type == MappingType::note)
    {
        // A bipolar axis rests in the middle, so the note fires on distance
        // from rest in either direction.
        const double travel = def.bipolar ? std::abs (t - 0.5) * 2 : t;
        // How fast it is moving, for 'speed' velocity.
        if (! rt.hasPrevTravel || dt <= 0)
        {
            rt.speedVel = m.velocity;
        }
        else
        {
            const double v = clamp01 ((travel - rt.prevTravel) / dt / kSpeedFullPerSec);
            rt.speedVel = roundClamp (m.velMin + v * (m.velocity - m.velMin), 1, 127);
        }
        rt.prevTravel = travel;
        rt.hasPrevTravel = true;
        // Hysteresis so a value hovering at the threshold doesn't machine-gun.
        const bool over = rt.pressed ? travel >= m.threshold * 0.85 : travel >= m.threshold;
        rt.pressed = over;
        setOn (rt, over, out, 0, over && ! rt.on ? velocityFor (rt, state) : -1);
        return;
    }
    if (m.type == MappingType::relative)
    {
        if (def.activeWhile >= 0)
        {
            // Trackpad: steps follow finger travel, like turning a knob.
            if (rt.hasPrevT)
                rt.acc += (t - rt.prevT) * m.speed;
            rt.prevT = t;
            rt.hasPrevT = true;
        }
        else
        {
            // Stick / trigger / motion: deflection sets how fast it turns.
            const double v = def.bipolar ? (t - 0.5) * 2 : t;
            rt.acc += v * m.speed * dt;
        }
        const double steps = std::trunc (rt.acc);
        if (steps != 0)
        {
            rt.acc -= steps;
            // Two's-complement relative CC: 1..63 = up, 127..65 = down.
            const int n = (int) std::max (-63.0, std::min (63.0, steps));
            out.push_back (controlChange (m.channel, m.cc, n > 0 ? n : 128 + n));
        }
        return;
    }
    if (rt.last == -1 && def.activeWhile < 0 && m.gate < 0)
    {
        // First sample of an always-on axis: remember where it is but stay
        // quiet, so connecting the controller or editing a mapping doesn't
        // yank a parameter in the DAW to the axis's rest value.
        MidiList discard;
        sendPosition (rt, t, discard);
        return;
    }
    sendPosition (rt, t, out);
}

void Engine::sendPosition (Runtime& rt, double t, MidiList& out)
{
    const auto& m = rt.mapping;
    if (m.type == MappingType::pitchbend)
    {
        const int v = roundClamp (t * 16383, 0, 16383);
        if (v != rt.last)
        {
            rt.last = v;
            out.push_back (pitchBend (m.channel, v));
        }
    }
    else
    {
        const int v = roundClamp (m.min + t * (m.max - m.min), 0, 127);
        if (v != rt.last)
        {
            rt.last = v;
            out.push_back (controlChange (m.channel, m.cc, v));
        }
    }
}

std::vector<LearnStep> learnMessages (const Mapping& m)
{
    if (m.type == MappingType::note)
        return { { 0, noteOn (m.channel, m.note, m.velocity) }, { 120, noteOff (m.channel, m.note) } };
    if (m.type == MappingType::pitchbend)
        return { { 0, pitchBend (m.channel, 10000) }, { 40, pitchBend (m.channel, 8192) } };
    if (m.type == MappingType::relative)
        return { { 0, controlChange (m.channel, m.cc, 1) }, { 40, controlChange (m.channel, m.cc, 1) },
                 { 80, controlChange (m.channel, m.cc, 127) }, { 120, controlChange (m.channel, m.cc, 127) } };
    const int lo = std::min (m.min, m.max);
    const int hi = std::max (m.min, m.max);
    const int mid = (int) jsRound ((lo + hi) / 2.0);
    return { { 0, controlChange (m.channel, m.cc, hi) }, { 40, controlChange (m.channel, m.cc, mid) },
             { 80, controlChange (m.channel, m.cc, lo) } };
}

} // namespace scm
