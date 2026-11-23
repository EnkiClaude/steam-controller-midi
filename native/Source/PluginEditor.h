#pragma once

#include "PluginProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

/** The plugin window: the same web interface as the browser app, in a WebView. */
class ScmEditor final : public juce::AudioProcessorEditor,
                        private juce::Timer
{
public:
    explicit ScmEditor (ScmProcessor&);
    ~ScmEditor() override;

    void resized() override;
    void paint (juce::Graphics&) override;

private:
    void timerCallback() override;
    void handleCommand (const juce::var&);
    void sendInit();
    void sendMidiStatus();
    void sendHostInfo (bool force);
    juce::var hidStatusVar (const scm::Hub::Status&) const;
    static std::optional<juce::WebBrowserComponent::Resource> getResource (const juce::String& url);

    ScmProcessor& processor;
    std::unique_ptr<juce::WebBrowserComponent> web;
    std::unique_ptr<juce::FileChooser> chooser;

    bool pageReady = false;
    uint32_t lastStateVersion = 0xffffffff;
    scm::Hub::Status lastStatus;
    bool statusSent = false;
    int lastConfigGeneration = 0;
    int ticks = 0;
    int hostTicks = 0;
    double lastHostTempo = -1;
    bool lastHostPlaying = false;
    std::vector<ScmProcessor::MonitorEntry> monitorScratch;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ScmEditor)
};
