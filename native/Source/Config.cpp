#include "Config.h"

namespace scm
{

namespace
{
int clampInt (const juce::var& v, int lo, int hi, int fallback)
{
    if (! (v.isInt() || v.isInt64() || v.isDouble()))
        return fallback;
    return juce::jlimit (lo, hi, juce::roundToInt ((double) v));
}

double clampNum (const juce::var& v, double lo, double hi, double fallback)
{
    if (! (v.isInt() || v.isInt64() || v.isDouble()))
        return fallback;
    const double d = (double) v;
    return std::isfinite (d) ? juce::jlimit (lo, hi, d) : fallback;
}
} // namespace

std::optional<Mapping> mappingFromVar (const juce::var& v)
{
    if (! v.isObject())
        return std::nullopt;

    const auto input = v["input"].toString().toStdString();
    Mapping m;
    const int button = buttonIndex (input);
    const int axis = axisIndex (input);
    if (button < 0 && axis < 0)
        return std::nullopt;
    m.isAxis = button < 0;
    m.input = m.isAxis ? axis : button;

    m.id = v["id"].toString().toStdString();
    m.enabled = ! (v["enabled"].isBool() && ! (bool) v["enabled"]);

    const auto type = v["type"].toString();
    m.type = type == "cc" ? MappingType::cc
           : type == "pitchbend" ? MappingType::pitchbend
           : type == "relative" ? MappingType::relative
           : type == "note" ? MappingType::note
           : (m.isAxis ? MappingType::cc : MappingType::note);
    if (! m.isAxis && (m.type == MappingType::pitchbend || m.type == MappingType::relative))
        m.type = MappingType::cc;

    m.channel = clampInt (v["channel"], 1, 16, 1);
    m.note = clampInt (v["note"], 0, 127, 60);
    m.velocity = clampInt (v["velocity"], 1, 127, 100);
    m.cc = clampInt (v["cc"], 0, 127, 1);
    m.min = clampInt (v["min"], 0, 127, 0);
    m.max = clampInt (v["max"], 0, 127, 127);
    m.toggle = v["toggle"].isBool() && (bool) v["toggle"];
    const int grid = clampInt (v["grid"], 0, 4, 0);
    m.grid = grid >= 2 ? grid : 0;
    m.speed = clampNum (v["speed"], 1, 500, 64);
    m.invert = v["invert"].isBool() && (bool) v["invert"];
    m.deadzone = clampNum (v["deadzone"], 0, 0.9, 0);
    m.curve = clampNum (v["curve"], 0.2, 5, 1);
    m.smooth = clampNum (v["smooth"], 0, 0.95, 0);
    m.threshold = clampNum (v["threshold"], 0.02, 0.98, 0.5);
    m.gate = v["gate"].isString() ? buttonIndex (v["gate"].toString().toStdString()) : -1;
    m.releaseReset = v["release"].toString() == "reset";
    return m;
}

std::vector<Mapping> mappingsFromConfig (const juce::String& json)
{
    std::vector<Mapping> out;
    const auto root = juce::JSON::parse (json);
    const auto* presets = root["presets"].getArray();
    if (presets == nullptr || presets->isEmpty())
        return out;
    const int active = juce::jlimit (0, presets->size() - 1, clampInt (root["active"], 0, 100000, 0));
    if (const auto* list = presets->getReference (active)["mappings"].getArray())
        for (const auto& item : *list)
            if (auto m = mappingFromVar (item))
                out.push_back (std::move (*m));
    return out;
}

} // namespace scm
