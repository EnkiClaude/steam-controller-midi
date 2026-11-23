#pragma once

#include "Config.h"
#include "Core.h"
#include "Hub.h"

#include <juce_audio_utils/juce_audio_utils.h>

class ScmProcessor final : public juce::AudioProcessor,
                           private scm::Hub::Client
{
public:
    ScmProcessor();
    ~ScmProcessor() override;

    // --- AudioProcessor ---
    void prepareToPlay (double, int) override {}
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using juce::AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    // --- used by the editor (message thread) ---
    bool isStandalone() const { return wrapperType == wrapperType_Standalone; }
    juce::String formatName() const;

    juce::String getConfig() const;
    /** Bumped when the config is replaced from outside the editor (project load). */
    int getConfigGeneration() const { return configGeneration.load(); }
    void setConfig (const juce::String& json);
    void setFlags (bool learn, const juce::String& solo);
    void sendLearn (const juce::var& mapping);
    void panic();
    /** The settings dialog's "test" button: one tap at the configured strength. */
    void hapticTest();

    /** The host's tempo, or 0 when it doesn't say (and always in the standalone app). */
    double getHostTempo() const { return hostBpm.load(); }
    bool isHostPlaying() const { return hostPlaying.load(); }

    scm::Hub& getHub() { return *hub; }

    struct MonitorEntry
    {
        scm::MidiMessage message;
        bool sent;
    };
    /** Messages produced since the last call, oldest first. */
    void drainMonitor (std::vector<MonitorEntry>&);

    // Standalone only: where the MIDI goes.
    struct MidiPort
    {
        juce::String id, name;
    };
    std::vector<MidiPort> getMidiOutputs() const;
    juce::String getMidiOutputId() const;
    void setMidiOutputId (const juce::String&);
    bool hasOutput() const;

private:
    static BusesProperties makeBuses();
    void controllerChanged (const scm::ControllerState&, double nowMs) override;
    void controllerGone() override;

    /** Must be called with engineLock held. */
    void deliver (const scm::MidiList&, bool force);
    /** Take over a parsed config. Must be called with engineLock held. */
    void applyConfigLocked (const scm::ConfigData&, scm::MidiList& out);
    /** Push tempo and scale into the engine. Must be called with engineLock held. */
    void applyOptionsLocked();
    /** Audio thread: tap on the beat / bar while the host plays. */
    void metronome (const juce::AudioPlayHead::PositionInfo&, int numSamples);
    void openMidiOutput();

    juce::SharedResourcePointer<scm::Hub> hub;

    juce::CriticalSection engineLock;
    scm::Engine engine;
    juce::String config;
    std::string solo;
    bool learn = false;
    std::atomic<int> configGeneration { 0 };

    // tempo and scale (engineLock)
    double settingsTempo = 120;
    int scaleRoot = 0, scaleIndex = 0;
    /** tempo the engine was last given, to notice host tempo changes */
    double appliedTempo = -1;

    // read on the audio thread, so atomics rather than engineLock
    std::atomic<bool> hapticNotes { false };
    std::atomic<float> hapticStrength { 0.5f };
    std::atomic<int> metronomeMode { (int) scm::Metronome::off };
    std::atomic<double> hostBpm { 0.0 };
    std::atomic<bool> hostPlaying { false };
    /** audio thread only: ppq of the last beat we tapped, so a beat that
        straddles two blocks taps once */
    double lastBeatPpq = -1e9;

    // hub/message thread → audio thread
    static constexpr int kFifoSize = 2048;
    juce::AbstractFifo audioFifo { kFifoSize };
    std::array<scm::MidiMessage, kFifoSize> audioQueue {};

    // → editor
    juce::AbstractFifo monitorFifo { kFifoSize };
    std::array<MonitorEntry, kFifoSize> monitorQueue {};

    // Standalone MIDI output
    static constexpr const char* kVirtualId = "virtual";
    std::unique_ptr<juce::MidiOutput> virtualOut;
    std::unique_ptr<juce::MidiOutput> deviceOut;
    juce::String midiOutId;

    JUCE_DECLARE_WEAK_REFERENCEABLE (ScmProcessor)
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ScmProcessor)
};
