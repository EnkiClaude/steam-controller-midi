// Reads the Steam Controller over HID on a background thread and hands each
// new snapshot to every plugin instance. One Hub is shared by all instances
// in a process, so several copies of the plugin can use the same controller.
#pragma once

#include "Core.h"

#include <juce_core/juce_core.h>

struct hid_device_;

namespace scm
{

class Hub : private juce::Thread
{
public:
    Hub();
    ~Hub() override;

    struct Client
    {
        virtual ~Client() = default;
        /** Called on the hub thread (or the caller's thread for simulated input) with the hub lock held. */
        virtual void controllerChanged (const ControllerState&, double nowMs) = 0;
        /** The controller went away or fell asleep: stop anything sounding. */
        virtual void controllerGone() = 0;
    };

    void addClient (Client*);
    void removeClient (Client*);

    enum class Phase { disconnected, waiting, connected };

    struct Status
    {
        Phase phase = Phase::disconnected;
        juce::String deviceName;
        juce::String transport;
        int battery = -1;
        bool charging = false;
        /** 1 accepted, 0 rejected, -1 not tried yet */
        int settingsOk = -1;
        juce::String error;

        bool operator== (const Status& o) const
        {
            return phase == o.phase && deviceName == o.deviceName && transport == o.transport && battery == o.battery
                && charging == o.charging && settingsOk == o.settingsOk && error == o.error;
        }
    };

    Status getStatus() const;
    ControllerState getState() const;
    /** Bumped whenever the state changes. */
    uint32_t getStateVersion() const { return stateVersion.load(); }

    /** Drive an input from the UI, with or without a controller attached. */
    void simulate (bool isAxis, int index, double value);
    void simulateEnd (bool isAxis, int index);
    void recenterMotion();

    /** JSON describing what the hub has seen, for remote debugging. */
    juce::var diagnostics() const;

private:
    void run() override;
    void scan();
    void closeAll();
    void handleReport (int device, const uint8_t* data, int size, double nowMs);
    void maintain (double nowMs);
    void tickClients (double nowMs);
    void goneLocked();

    struct Device
    {
        hid_device_* handle = nullptr;
        juce::String path;
        uint16_t pid = 0;
    };

    juce::CriticalSection lock;
    std::vector<Device> devices;
    std::vector<Client*> clients;
    ControllerState state;
    TritonContext ctx;
    Debouncer debouncer;
    /** index of the interface whose state reports we are following, or -1 */
    int source = -1;
    Status status;
    std::array<bool, kNumButtons> simButtons {};
    std::array<bool, kNumAxes> simAxes {};
    int simCount = 0;
    std::atomic<uint32_t> stateVersion { 0 };

    double lastScan = -1e9;
    double lastMaintenance = -1e9;
    double lastStateReport = -1e9;
    int activeDevice = -1;

    // diagnostics
    juce::int64 reportCount = 0;
    std::map<int, juce::String> lastReports;
};

} // namespace scm
