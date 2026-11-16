#include "PluginEditor.h"

#include "BinaryData.h"

namespace
{
const juce::Identifier kEvent ("sc");

const char* mimeFor (const juce::String& name)
{
    if (name.endsWithIgnoreCase (".html")) return "text/html";
    if (name.endsWithIgnoreCase (".js")) return "text/javascript";
    if (name.endsWithIgnoreCase (".css")) return "text/css";
    if (name.endsWithIgnoreCase (".svg")) return "image/svg+xml";
    if (name.endsWithIgnoreCase (".json")) return "application/json";
    if (name.endsWithIgnoreCase (".png")) return "image/png";
    return "application/octet-stream";
}

juce::var object (std::initializer_list<std::pair<const char*, juce::var>> props)
{
    auto* o = new juce::DynamicObject();
    for (auto& p : props)
        o->setProperty (p.first, p.second);
    return juce::var (o);
}
} // namespace

std::optional<juce::WebBrowserComponent::Resource> ScmEditor::getResource (const juce::String& url)
{
    // The built web app is embedded in the binary; look files up by name.
    auto name = url.fromLastOccurrenceOf ("/", false, false).upToFirstOccurrenceOf ("?", false, false);
    if (name.isEmpty())
        name = "index.html";

    for (int i = 0; i < BinaryData::namedResourceListSize; ++i)
    {
        if (name == BinaryData::originalFilenames[i])
        {
            int size = 0;
            if (const auto* data = BinaryData::getNamedResource (BinaryData::namedResourceList[i], size))
            {
                juce::WebBrowserComponent::Resource r;
                r.data.resize ((size_t) size);
                std::memcpy (r.data.data(), data, (size_t) size);
                r.mimeType = mimeFor (name);
                return r;
            }
        }
    }
    return std::nullopt;
}

ScmEditor::ScmEditor (ScmProcessor& p) : AudioProcessorEditor (&p), processor (p)
{
    auto options = juce::WebBrowserComponent::Options()
        .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
        .withWinWebView2Options (juce::WebBrowserComponent::Options::WinWebView2()
            .withUserDataFolder (juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("SteamControllerMIDI"))
            .withBackgroundColour (juce::Colour (0xff0a0b0d)))
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([] (const juce::String& url) { return getResource (url); })
        .withEventListener (kEvent, [this] (const juce::var& payload) { handleCommand (payload); });

    web = std::make_unique<juce::WebBrowserComponent> (options);
    addAndMakeVisible (*web);
    web->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    setResizable (true, true);
    setResizeLimits (960, 620, 2400, 1600);
    setSize (1240, 800);
    startTimerHz (30);
}

ScmEditor::~ScmEditor()
{
    stopTimer();
    // Don't leave a Test button "held" or learn/solo latched once the window is gone.
    processor.setFlags (false, {});
}

void ScmEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff0a0b0d));
}

void ScmEditor::resized()
{
    if (web != nullptr)
        web->setBounds (getLocalBounds());
}

juce::var ScmEditor::hidStatusVar (const scm::Hub::Status& s) const
{
    const char* phase = s.phase == scm::Hub::Phase::connected ? "connected"
                      : s.phase == scm::Hub::Phase::waiting ? "waiting" : "disconnected";
    return object ({
        { "phase", phase },
        { "deviceName", s.deviceName },
        { "transport", s.transport },
        { "battery", s.battery < 0 ? juce::var() : juce::var (s.battery) },
        { "charging", s.charging },
        { "settingsOk", s.settingsOk < 0 ? juce::var() : juce::var (s.settingsOk == 1) },
        { "error", s.error },
    });
}

void ScmEditor::sendMidiStatus()
{
    juce::Array<juce::var> outputs;
    for (auto& port : processor.getMidiOutputs())
        outputs.add (object ({ { "id", port.id }, { "name", port.name } }));
    web->emitEventIfBrowserIsVisible (kEvent, object ({
        { "type", "midi" },
        { "outputs", outputs },
        { "selectedId", processor.getMidiOutputId() },
        { "hasOutput", processor.hasOutput() },
    }));
}

void ScmEditor::sendInit()
{
    lastConfigGeneration = processor.getConfigGeneration();
    web->emitEventIfBrowserIsVisible (kEvent, object ({
        { "type", "init" },
        { "format", processor.formatName() },
        { "config", processor.getConfig() },
    }));
    statusSent = false;
    lastStateVersion = 0xffffffff;
    sendMidiStatus();
}

void ScmEditor::handleCommand (const juce::var& c)
{
    const auto cmd = c["cmd"].toString();
    auto& hub = processor.getHub();

    auto input = [&c] (bool& isAxis, int& index)
    {
        const auto id = c["input"].toString().toStdString();
        index = scm::buttonIndex (id);
        isAxis = index < 0;
        if (isAxis)
            index = scm::axisIndex (id);
        return index >= 0;
    };

    if (cmd == "hello")
    {
        pageReady = true;
        sendInit();
    }
    else if (cmd == "config")
    {
        processor.setConfig (c["json"].toString());
    }
    else if (cmd == "flags")
    {
        processor.setFlags ((bool) c["learn"], c["solo"].toString());
    }
    else if (cmd == "simulate")
    {
        bool isAxis;
        int index;
        if (input (isAxis, index))
            hub.simulate (isAxis, index, c["value"].isBool() ? ((bool) c["value"] ? 1.0 : 0.0) : (double) c["value"]);
    }
    else if (cmd == "simulateEnd")
    {
        bool isAxis;
        int index;
        if (input (isAxis, index))
            hub.simulateEnd (isAxis, index);
    }
    else if (cmd == "sendLearn")
    {
        processor.sendLearn (c["mapping"]);
    }
    else if (cmd == "panic")
    {
        processor.panic();
    }
    else if (cmd == "recenter")
    {
        hub.recenterMotion();
    }
    else if (cmd == "midiOut")
    {
        processor.setMidiOutputId (c["id"].toString());
        sendMidiStatus();
    }
    else if (cmd == "exportFile")
    {
        // Browser-style downloads don't work inside a plugin window.
        const auto text = c["text"].toString();
        const auto start = juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile (c["name"].toString());
        chooser = std::make_unique<juce::FileChooser> ("Export preset", start, "*.json");
        chooser->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles
                                  | juce::FileBrowserComponent::warnAboutOverwriting,
                              [text] (const juce::FileChooser& fc)
                              {
                                  auto file = fc.getResult();
                                  if (file == juce::File())
                                      return;
                                  if (! file.hasFileExtension ("json"))
                                      file = file.withFileExtension ("json");
                                  file.replaceWithText (text);
                              });
    }
    else if (cmd == "importFile")
    {
        chooser = std::make_unique<juce::FileChooser> ("Import preset",
                                                       juce::File::getSpecialLocation (juce::File::userDocumentsDirectory), "*.json");
        juce::Component::SafePointer<ScmEditor> safe (this);
        chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                              [safe] (const juce::FileChooser& fc)
                              {
                                  const auto file = fc.getResult();
                                  if (safe == nullptr || ! file.existsAsFile() || file.getSize() > 4 * 1024 * 1024)
                                      return;
                                  safe->web->emitEventIfBrowserIsVisible (kEvent, object ({
                                      { "type", "import" },
                                      { "name", file.getFileName() },
                                      { "text", file.loadFileAsString() },
                                  }));
                              });
    }
    else if (cmd == "diag")
    {
        web->emitEventIfBrowserIsVisible (kEvent, object ({ { "type", "diag" }, { "data", hub.diagnostics() } }));
    }
}

void ScmEditor::timerCallback()
{
    if (! pageReady)
        return;
    auto& hub = processor.getHub();

    // The host loaded a project or preset behind the page's back.
    if (processor.getConfigGeneration() != lastConfigGeneration)
        sendInit();

    const auto status = hub.getStatus();
    if (! statusSent || ! (status == lastStatus))
    {
        statusSent = true;
        lastStatus = status;
        web->emitEventIfBrowserIsVisible (kEvent, object ({ { "type", "hid" }, { "hid", hidStatusVar (status) } }));
    }

    // MIDI ports come and go (standalone); refresh about once a second.
    if (processor.isStandalone() && ++ticks % 30 == 0)
        sendMidiStatus();

    monitorScratch.clear();
    processor.drainMonitor (monitorScratch);
    const auto version = hub.getStateVersion();
    if (version == lastStateVersion && monitorScratch.empty())
        return;
    lastStateVersion = version;

    const auto state = hub.getState();
    juce::Array<juce::var> axes;
    for (double v : state.axes)
        axes.add (v);
    juce::Array<juce::var> monitor;
    for (auto& e : monitorScratch)
    {
        juce::Array<juce::var> m;
        m.add ((int) e.message.bytes[0]);
        m.add ((int) e.message.bytes[1]);
        m.add ((int) e.message.bytes[2]);
        m.add (e.sent);
        monitor.add (juce::var (m));
    }
    web->emitEventIfBrowserIsVisible (kEvent, object ({
        { "type", "tick" },
        // as a double: a 32-bit mask can exceed a signed int
        { "buttons", (double) state.buttonMask() },
        { "axes", axes },
        { "monitor", monitor },
    }));
}
