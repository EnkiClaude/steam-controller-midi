#include "PluginProcessor.h"

#include "BinaryData.h"
#include "PluginEditor.h"

juce::AudioProcessor::BusesProperties ScmProcessor::makeBuses()
{
   #if JucePlugin_IsMidiEffect
    return {};
   #else
    // Hosts only load an instrument that has an audio output; it stays silent.
    return BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true);
   #endif
}

ScmProcessor::ScmProcessor() : AudioProcessor (makeBuses())
{
    // Until the host or the saved settings say otherwise, use the default
    // preset so the controller does something straight away.
    config = juce::String::fromUTF8 (BinaryData::defaultconfig_json, BinaryData::defaultconfig_jsonSize);
    {
        const juce::ScopedLock sl (engineLock);
        scm::MidiList out;
        engine.setMappings (scm::mappingsFromConfig (config), out);
    }

    if (isStandalone())
    {
       #if JUCE_MAC || JUCE_LINUX
        // Our own port, so Live sees "Steam Controller MIDI" with no setup.
        virtualOut = juce::MidiOutput::createNewDevice ("Steam Controller MIDI");
        if (virtualOut != nullptr)
            midiOutId = kVirtualId;
       #endif
        if (midiOutId.isEmpty())
        {
            // No virtual ports on Windows: prefer a loopback port if one exists.
            for (auto& d : juce::MidiOutput::getAvailableDevices())
                if (d.name.containsIgnoreCase ("loop"))
                {
                    midiOutId = d.identifier;
                    break;
                }
            openMidiOutput();
        }
    }

    hub->addClient (this);
}

ScmProcessor::~ScmProcessor()
{
    hub->removeClient (this);
    const juce::ScopedLock sl (engineLock);
    scm::MidiList out;
    engine.releaseAll (out);
    deliver (out, true);
}

bool ScmProcessor::isMidiEffect() const
{
   #if JucePlugin_IsMidiEffect
    return true;
   #else
    return false;
   #endif
}

bool ScmProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
   #if JucePlugin_IsMidiEffect
    juce::ignoreUnused (layouts);
    return true;
   #else
    const auto out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
   #endif
}

juce::String ScmProcessor::formatName() const
{
    switch (wrapperType)
    {
        case wrapperType_Standalone: return "standalone";
        case wrapperType_VST3: return "vst3";
        case wrapperType_AudioUnit: return "au";
        default: return "plugin";
    }
}

void ScmProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();
    // Incoming MIDI is dropped rather than passed through: echoing a track's
    // input back out is an easy way to build a feedback loop.
    midi.clear();

    const auto scope = audioFifo.read (audioFifo.getNumReady());
    auto add = [&] (int start, int count)
    {
        for (int i = 0; i < count; ++i)
            midi.addEvent (audioQueue[(size_t) (start + i)].bytes, 3, 0);
    };
    add (scope.startIndex1, scope.blockSize1);
    add (scope.startIndex2, scope.blockSize2);
}

// ------------------------------------------------------------- controller

void ScmProcessor::controllerChanged (const scm::ControllerState& state, double nowMs)
{
    const juce::ScopedLock sl (engineLock);
    scm::MidiList out;
    engine.process (state, solo, nowMs, out);
    deliver (out, false);
}

void ScmProcessor::controllerGone()
{
    const juce::ScopedLock sl (engineLock);
    scm::MidiList out;
    engine.releaseAll (out);
    deliver (out, true);
}

void ScmProcessor::deliver (const scm::MidiList& messages, bool force)
{
    if (messages.empty())
        return;
    const bool muted = learn && ! force;
    const bool standalone = isStandalone();
    auto* port = midiOutId == kVirtualId ? virtualOut.get() : deviceOut.get();

    for (const auto& m : messages)
    {
        bool sent = false;
        if (! muted)
        {
            if (standalone)
            {
                if (port != nullptr)
                {
                    port->sendMessageNow (juce::MidiMessage (m.bytes[0], m.bytes[1], m.bytes[2]));
                    sent = true;
                }
            }
            else
            {
                const auto scope = audioFifo.write (1);
                if (scope.blockSize1 > 0)
                {
                    audioQueue[(size_t) scope.startIndex1] = m;
                    sent = true;
                }
            }
        }
        const auto scope = monitorFifo.write (1);
        if (scope.blockSize1 > 0)
            monitorQueue[(size_t) scope.startIndex1] = { m, sent };
    }
}

void ScmProcessor::drainMonitor (std::vector<MonitorEntry>& out)
{
    const auto scope = monitorFifo.read (monitorFifo.getNumReady());
    for (int i = 0; i < scope.blockSize1; ++i) out.push_back (monitorQueue[(size_t) (scope.startIndex1 + i)]);
    for (int i = 0; i < scope.blockSize2; ++i) out.push_back (monitorQueue[(size_t) (scope.startIndex2 + i)]);
}

// ------------------------------------------------------------------ config

juce::String ScmProcessor::getConfig() const
{
    const juce::ScopedLock sl (engineLock);
    return config;
}

void ScmProcessor::setConfig (const juce::String& json)
{
    auto mappings = scm::mappingsFromConfig (json);
    const juce::ScopedLock sl (engineLock);
    config = json;
    scm::MidiList out;
    engine.setMappings (mappings, out);
    deliver (out, true);
}

void ScmProcessor::setFlags (bool learnOn, const juce::String& soloId)
{
    const juce::ScopedLock sl (engineLock);
    if (learnOn && ! learn)
    {
        // Entering learn mode: silence anything still sounding.
        scm::MidiList out;
        engine.releaseAll (out);
        deliver (out, true);
    }
    learn = learnOn;
    solo = soloId.toStdString();
}

void ScmProcessor::sendLearn (const juce::var& mappingVar)
{
    const auto mapping = scm::mappingFromVar (mappingVar);
    if (! mapping)
        return;
    for (const auto& step : scm::learnMessages (*mapping))
    {
        juce::WeakReference<ScmProcessor> weak (this);
        const auto message = step.message;
        auto send = [weak, message]
        {
            if (auto* self = weak.get())
            {
                const juce::ScopedLock sl (self->engineLock);
                self->deliver ({ message }, true);
            }
        };
        if (step.delayMs == 0)
            send();
        else
            juce::Timer::callAfterDelay (step.delayMs, send);
    }
}

void ScmProcessor::panic()
{
    const juce::ScopedLock sl (engineLock);
    scm::MidiList out;
    engine.releaseAll (out);
    for (int ch = 0; ch < 16; ++ch)
        out.push_back ({ { (uint8_t) (0xb0 | ch), 123, 0 } });
    deliver (out, true);
}

// ------------------------------------------------------- standalone output

std::vector<ScmProcessor::MidiPort> ScmProcessor::getMidiOutputs() const
{
    std::vector<MidiPort> out;
    if (! isStandalone())
        return out;
    if (virtualOut != nullptr)
        out.push_back ({ kVirtualId, "Steam Controller MIDI (this app's own port)" });
    for (auto& d : juce::MidiOutput::getAvailableDevices())
        if (d.name != "Steam Controller MIDI")
            out.push_back ({ d.identifier, d.name });
    return out;
}

juce::String ScmProcessor::getMidiOutputId() const
{
    const juce::ScopedLock sl (engineLock);
    return midiOutId;
}

void ScmProcessor::setMidiOutputId (const juce::String& id)
{
    const juce::ScopedLock sl (engineLock);
    if (id == midiOutId)
        return;
    scm::MidiList out;
    engine.releaseAll (out);
    deliver (out, true);
    midiOutId = id;
    openMidiOutput();
}

void ScmProcessor::openMidiOutput()
{
    deviceOut.reset();
    if (midiOutId.isNotEmpty() && midiOutId != kVirtualId)
        deviceOut = juce::MidiOutput::openDevice (midiOutId);
}

bool ScmProcessor::hasOutput() const
{
    if (! isStandalone())
        return true;
    const juce::ScopedLock sl (engineLock);
    return midiOutId == kVirtualId ? virtualOut != nullptr : deviceOut != nullptr;
}

// ------------------------------------------------------------------- state

void ScmProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    auto* o = new juce::DynamicObject();
    {
        const juce::ScopedLock sl (engineLock);
        o->setProperty ("config", config);
        o->setProperty ("midiOut", midiOutId);
    }
    const auto text = juce::JSON::toString (juce::var (o), true);
    dest.replaceAll (text.toRawUTF8(), text.getNumBytesAsUTF8());
}

void ScmProcessor::setStateInformation (const void* data, int size)
{
    const auto root = juce::JSON::parse (juce::String::fromUTF8 (static_cast<const char*> (data), size));
    if (! root.isObject())
        return;
    const auto json = root["config"].toString();
    if (! scm::mappingsFromConfig (json).empty() || juce::JSON::parse (json)["presets"].isArray())
    {
        setConfig (json);
        ++configGeneration;
    }
    if (isStandalone())
    {
        const auto id = root["midiOut"].toString();
        // Only restore a port that still exists.
        for (auto& p : getMidiOutputs())
            if (p.id == id)
                setMidiOutputId (id);
    }
}

juce::AudioProcessorEditor* ScmProcessor::createEditor()
{
    return new ScmEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new ScmProcessor();
}
