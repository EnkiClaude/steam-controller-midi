#include "Config.h"

namespace scm
{

namespace
{
bool isNumber (const juce::var& v)
{
    return (v.isInt() || v.isInt64() || v.isDouble()) && std::isfinite ((double) v);
}

/** Math.round: halves go up, so -2.5 → -2 (juce::roundToInt differs). */
double jsRound (double v) { return std::floor (v + 0.5); }

/** `int()` in mapping.ts: round, then clamp; non-numbers get the fallback. */
int clampInt (const juce::var& v, int lo, int hi, int fallback)
{
    const double n = isNumber (v) ? jsRound ((double) v) : (double) fallback;
    return (int) juce::jlimit ((double) lo, (double) hi, n);
}

/** `num()` in mapping.ts: clamp without rounding. */
double clampNum (const juce::var& v, double lo, double hi, double fallback)
{
    return juce::jlimit (lo, hi, isNumber (v) ? (double) v : fallback);
}

bool isTrue (const juce::var& v) { return v.isBool() && (bool) v; }
bool isFalse (const juce::var& v) { return v.isBool() && ! (bool) v; }

bool isGridPadButton (int button)
{
    const auto id = juce::String (kButtons[(size_t) button].id);
    return id == "lpad_click" || id == "lpad_touch" || id == "rpad_click" || id == "rpad_touch";
}
} // namespace

std::optional<Mapping> mappingFromVar (const juce::var& v)
{
    if (! v.isObject() || ! v["input"].isString())
        return std::nullopt;

    const auto input = v["input"].toString().toStdString();
    Mapping m;
    const int button = buttonIndex (input);
    const int axis = axisIndex (input);
    if (button < 0 && axis < 0)
        return std::nullopt;
    m.isAxis = button < 0;
    m.input = m.isAxis ? axis : button;
    const bool isButton = ! m.isAxis;
    const bool gridPad = isButton && isGridPadButton (button);

    // Defaults that depend on the input, as createMapping gives them.
    const auto& axisDef = kAxes[(size_t) (m.isAxis ? axis : 0)];
    const bool motion = m.isAxis && axis >= kTiltPitch;
    const double defDeadzone = m.isAxis && axisDef.bipolar && axisDef.activeWhile < 0 && ! motion ? 0.08 : 0;
    const double defSmooth = motion ? 0.6 : 0;

    m.id = v["id"].isString() ? v["id"].toString().toStdString() : std::string();
    m.enabled = ! isFalse (v["enabled"]);

    const auto type = v["type"].toString();
    m.type = type == "cc" ? MappingType::cc
           : type == "pitchbend" ? MappingType::pitchbend
           : type == "relative" ? MappingType::relative
           : type == "note" ? MappingType::note
           : (m.isAxis ? MappingType::cc : MappingType::note);
    if (isButton && (m.type == MappingType::pitchbend || m.type == MappingType::relative))
        m.type = MappingType::cc;

    m.channel = clampInt (v["channel"], 1, 16, 1);
    m.note = clampInt (v["note"], 0, 127, 60);
    m.velocity = clampInt (v["velocity"], 1, 127, 100);
    m.cc = clampInt (v["cc"], 0, 127, 1);
    m.min = clampInt (v["min"], 0, 127, 0);
    m.max = clampInt (v["max"], 0, 127, 127);
    m.toggle = isTrue (v["toggle"]);
    // Only exactly 2, 3 or 4, and only on a trackpad click / touch.
    const auto& grid = v["grid"];
    m.grid = gridPad && isNumber (grid) && ((double) grid == 2 || (double) grid == 3 || (double) grid == 4) ? (int) (double) grid : 0;
    m.speed = clampNum (v["speed"], 1, 500, 64);
    m.invert = isTrue (v["invert"]);
    m.deadzone = clampNum (v["deadzone"], 0, 0.9, defDeadzone);
    m.curve = clampNum (v["curve"], 0.2, 5, 1);
    m.smooth = clampNum (v["smooth"], 0, 0.95, defSmooth);
    m.threshold = clampNum (v["threshold"], 0.02, 0.98, 0.5);
    m.gate = v["gate"].isString() ? buttonIndex (v["gate"].toString().toStdString()) : -1;
    m.releaseReset = v["release"].isString() && v["release"].toString() == "reset";

    // 'speed' only makes sense for an axis played as a note.
    const auto velFrom = v["velFrom"].isString() ? v["velFrom"].toString() : juce::String();
    m.velFrom = velFrom == "lt" ? VelocitySource::lt
              : velFrom == "rt" ? VelocitySource::rt
              : velFrom == "lpad_pressure" ? VelocitySource::lpadPressure
              : velFrom == "rpad_pressure" ? VelocitySource::rpadPressure
              : velFrom == "speed" && ! isButton ? VelocitySource::speed
              : VelocitySource::fixed;
    m.velMin = clampInt (v["velMin"], 1, 127, 1);
    m.gain = clampNum (v["gain"], 1, 10, 1);
    // REPEAT_RATES, exact values only, buttons only.
    const auto& repeat = v["repeat"];
    m.repeat = 0;
    if (isButton && isNumber (repeat))
        for (int rate : { 2, 3, 4, 6, 8 })
            if ((double) repeat == rate)
                m.repeat = rate;
    m.scale = ! isFalse (v["scale"]);
    m.mpe = gridPad && isTrue (v["mpe"]);
    m.bend = clampInt (v["bend"], 1, 48, 2);
    return m;
}

ConfigData configFromJson (const juce::String& json)
{
    ConfigData c;
    const auto root = juce::JSON::parse (json);

    // settings: sanitizeSettings in src/store.ts
    const auto& s = root["settings"];
    c.tempo = jsRound (clampNum (s["tempo"], 20, 300, 120));
    c.hapticNotes = isTrue (s["hapticNotes"]);
    c.hapticStrength = clampNum (s["hapticStrength"], 0.05, 1, 0.5);
    const auto metronome = s["metronome"].isString() ? s["metronome"].toString() : juce::String();
    c.metronome = metronome == "beat" ? Metronome::beat : metronome == "bar" ? Metronome::bar : Metronome::off;

    const auto* presets = root["presets"].getArray();
    if (presets == nullptr)
        return c;
    c.hasPresets = true;
    if (presets->isEmpty())
        return c;
    const int active = juce::jlimit (0, presets->size() - 1, clampInt (root["active"], 0, 100000, 0));
    const auto& preset = presets->getReference (active);
    c.scaleRoot = clampInt (preset["scaleRoot"], 0, 11, 0);
    c.scaleIndex = preset["scale"].isString() ? scaleIndex (preset["scale"].toString().toStdString()) : 0;

    if (const auto* list = preset["mappings"].getArray())
    {
        for (const auto& item : *list)
        {
            auto m = mappingFromVar (item);
            if (! m)
                continue;
            // The engine matches runtimes by id, so a missing or repeated id
            // gets a fresh one (sanitizePreset does the same).
            const bool clash = m->id.empty()
                || std::any_of (c.mappings.begin(), c.mappings.end(), [&] (const Mapping& o) { return o.id == m->id; });
            if (clash)
                m->id = "_native" + std::to_string (c.mappings.size());
            c.mappings.push_back (std::move (*m));
        }
    }
    return c;
}

} // namespace scm
