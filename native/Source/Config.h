// Converts the UI's JSON (the same shape the web app keeps in localStorage:
// { presets: [{ name, mappings: [...], scaleRoot, scale }], active, settings })
// into engine mappings and options. The rules mirror sanitizeMapping in
// src/core/mapping.ts and sanitizeSettings in src/store.ts.
#pragma once

#include "Core.h"

#include <juce_core/juce_core.h>

namespace scm
{

enum class Metronome { off, beat, bar };

/** Everything the native side needs from a config blob. */
struct ConfigData
{
    /** the active preset's mappings */
    std::vector<Mapping> mappings;
    /** whether the blob had a presets array at all */
    bool hasPresets = false;
    /** the active preset's scale mode: root 0-11 and an index into kScales */
    int scaleRoot = 0;
    int scaleIndex = 0;
    /** app-wide settings */
    double tempo = 120;
    bool hapticNotes = false;
    double hapticStrength = 0.5;
    Metronome metronome = Metronome::off;
};

/** One mapping object from the UI; nullopt if it names an input we don't know. */
std::optional<Mapping> mappingFromVar (const juce::var&);

/** Parse a whole config blob; anything missing or invalid gets its default. */
ConfigData configFromJson (const juce::String& json);

} // namespace scm
