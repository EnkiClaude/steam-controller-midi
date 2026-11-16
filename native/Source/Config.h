// Converts the UI's JSON (the same shape the web app keeps in localStorage:
// { presets: [{ name, mappings: [...] }], active }) into engine mappings.
#pragma once

#include "Core.h"

#include <juce_core/juce_core.h>

namespace scm
{

/** One mapping object from the UI; nullopt if it names an input we don't know. */
std::optional<Mapping> mappingFromVar (const juce::var&);

/** The active preset's mappings from a whole config blob. */
std::vector<Mapping> mappingsFromConfig (const juce::String& json);

} // namespace scm
