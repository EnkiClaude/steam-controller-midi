#include "Hub.h"

#include <hidapi.h>
#if JUCE_MAC
 #include <hidapi_darwin.h>
#endif

namespace scm
{

Hub::Hub() : juce::Thread ("Steam Controller HID")
{
    hid_init();
   #if JUCE_MAC
    // Share the controller with other apps instead of seizing it.
    hid_darwin_set_open_exclusive (0);
   #endif
    startThread (juce::Thread::Priority::high);
}

Hub::~Hub()
{
    stopThread (2000);
    closeAll();
    hid_exit();
}

void Hub::addClient (Client* c)
{
    const juce::ScopedLock sl (lock);
    clients.push_back (c);
}

void Hub::removeClient (Client* c)
{
    const juce::ScopedLock sl (lock);
    clients.erase (std::remove (clients.begin(), clients.end(), c), clients.end());
}

Hub::Status Hub::getStatus() const
{
    const juce::ScopedLock sl (lock);
    return status;
}

ControllerState Hub::getState() const
{
    const juce::ScopedLock sl (lock);
    return state;
}

void Hub::tickClients (double nowMs)
{
    ++stateVersion;
    for (auto* c : clients)
        c->controllerChanged (state, nowMs);
}

void Hub::goneLocked()
{
    state = ControllerState();
    ctx = TritonContext();
    simButtons.fill (false);
    simAxes.fill (false);
    simCount = 0;
    ++stateVersion;
    for (auto* c : clients)
        c->controllerGone();
}

void Hub::simulate (bool isAxis, int index, double value)
{
    const juce::ScopedLock sl (lock);
    auto mark = [this] (bool& flag, bool on)
    {
        if (flag != on)
        {
            flag = on;
            simCount += on ? 1 : -1;
        }
    };
    if (isAxis)
    {
        if (index < 0 || index >= kNumAxes) return;
        state.axes[(size_t) index] = value;
        mark (simAxes[(size_t) index], value != 0);
        // Trackpad axes only count while the pad is touched.
        const int touch = kAxes[(size_t) index].activeWhile;
        if (touch >= 0)
        {
            state.buttons[(size_t) touch] = true;
            mark (simButtons[(size_t) touch], true);
        }
    }
    else
    {
        if (index < 0 || index >= kNumButtons) return;
        state.buttons[(size_t) index] = value != 0;
        mark (simButtons[(size_t) index], value != 0);
    }
    tickClients (juce::Time::getMillisecondCounterHiRes());
}

void Hub::simulateEnd (bool isAxis, int index)
{
    const juce::ScopedLock sl (lock);
    if (! isAxis || index < 0 || index >= kNumAxes) return;
    const int touch = kAxes[(size_t) index].activeWhile;
    if (touch < 0) return;
    state.buttons[(size_t) touch] = false;
    if (simButtons[(size_t) touch])
    {
        simButtons[(size_t) touch] = false;
        --simCount;
    }
    tickClients (juce::Time::getMillisecondCounterHiRes());
}

void Hub::recenterMotion()
{
    const juce::ScopedLock sl (lock);
    ctx.recenter();
}

juce::var Hub::diagnostics() const
{
    const juce::ScopedLock sl (lock);
    auto* o = new juce::DynamicObject();
    o->setProperty ("reportCount", reportCount);
    juce::Array<juce::var> reports;
    for (auto& [id, hex] : lastReports)
    {
        auto* r = new juce::DynamicObject();
        r->setProperty ("id", id);
        r->setProperty ("hex", hex);
        reports.add (juce::var (r));
    }
    o->setProperty ("reports", reports);
    juce::Array<juce::var> devs;
    for (auto& d : devices)
    {
        auto* r = new juce::DynamicObject();
        r->setProperty ("productId", juce::String::toHexString ((int) d.pid));
        r->setProperty ("path", d.path);
        devs.add (juce::var (r));
    }
    o->setProperty ("devices", devs);
    return juce::var (o);
}

// ------------------------------------------------------------------ thread

void Hub::scan()
{
    std::vector<Device> found;
    juce::String name;
    juce::String error;

    if (auto* list = hid_enumerate (kValveVid, 0))
    {
        for (auto* info = list; info != nullptr; info = info->next)
        {
            if (! isTritonPid (info->product_id) || info->path == nullptr)
                continue;
            // One controller shows up as several HID interfaces and only one
            // carries the state reports, so open every one that lets us.
            if (auto* h = hid_open_path (info->path))
            {
                hid_set_nonblocking (h, 1);
                found.push_back ({ h, juce::String (info->path), info->product_id });
                if (name.isEmpty() && info->product_string != nullptr)
                    name = juce::String (info->product_string);
            }
            else
            {
                error = "Found the controller but could not open it. If Steam is running, quit it and try again.";
            }
        }
        hid_free_enumeration (list);
    }

    const juce::ScopedLock sl (lock);
    if (found.empty())
    {
        if (status.error != error)
            status.error = error;
        return;
    }
    devices = std::move (found);
    activeDevice = -1;
    const auto pid = devices.front().pid;
    status = {};
    status.phase = Phase::waiting;
    status.deviceName = name.isNotEmpty() ? name : juce::String ("Steam Controller");
    status.transport = pid == kPidBle ? "bluetooth" : (pid == kPidPuck || pid == kPidPuck2 ? "puck" : "usb");
    lastMaintenance = -1e9;
}

void Hub::closeAll()
{
    for (auto& d : devices)
        if (d.handle != nullptr)
            hid_close (d.handle);
    devices.clear();
    activeDevice = -1;
}

void Hub::maintain (double nowMs)
{
    lastMaintenance = nowMs;
    const auto report = buildSettingsReport (true);
    bool ok = false;
    for (auto& d : devices)
        if (hid_send_feature_report (d.handle, report.data(), report.size()) > 0)
            ok = true;

    const juce::ScopedLock sl (lock);
    status.settingsOk = ok ? 1 : 0;
}

void Hub::handleReport (const uint8_t* data, int size, double nowMs)
{
    const juce::ScopedLock sl (lock);
    ++reportCount;
    lastReports[data[0]] = juce::String::toHexString (data + 1, size - 1, 0);

    const auto r = parseReport (data[0], data + 1, (size_t) (size - 1), state, ctx);
    switch (r.type)
    {
        case ParsedReport::state:
            lastStateReport = nowMs;
            status.phase = Phase::connected;
            if (simCount > 0)
                for (size_t i = 0; i < (size_t) kNumButtons; ++i)
                    if (simButtons[i])
                        state.buttons[i] = true;
            tickClients (nowMs);
            break;
        case ParsedReport::battery:
            status.battery = r.batteryLevel;
            status.charging = r.charging;
            break;
        case ParsedReport::wireless:
            if (! r.connected)
            {
                // The puck is plugged in but the controller is off.
                status.phase = Phase::waiting;
                status.battery = -1;
                goneLocked();
            }
            break;
        case ParsedReport::unknown:
            break;
    }
}

void Hub::run()
{
    uint8_t buf[256];

    while (! threadShouldExit())
    {
        const double now = juce::Time::getMillisecondCounterHiRes();

        if (devices.empty())
        {
            if (now - lastScan >= 1000)
            {
                lastScan = now;
                scan();
            }
            if (devices.empty())
            {
                wait (16);
                // Keep time-based mappings turning while a Test slider is held.
                const juce::ScopedLock sl (lock);
                if (simCount > 0)
                    tickClients (juce::Time::getMillisecondCounterHiRes());
                continue;
            }
        }

        if (now - lastMaintenance >= kMaintenanceIntervalMs)
            maintain (now);

        bool any = false;
        bool failed = false;
        for (size_t i = 0; i < devices.size(); ++i)
        {
            // Drain whatever is queued on each interface without blocking.
            for (int n = 0; n < 16; ++n)
            {
                const int r = hid_read (devices[i].handle, buf, sizeof (buf));
                if (r < 0) { failed = true; break; }
                if (r == 0) break;
                any = true;
                if (r >= 2)
                {
                    handleReport (buf, r, juce::Time::getMillisecondCounterHiRes());
                    if (buf[0] == 0x42 || buf[0] == 0x45 || buf[0] == 0x47)
                        activeDevice = (int) i;
                }
            }
            if (failed) break;
        }

        if (failed)
        {
            // Unplugged: drop everything and go back to scanning.
            closeAll();
            const juce::ScopedLock sl (lock);
            status = {};
            goneLocked();
            lastScan = now;
            continue;
        }

        {
            const juce::ScopedLock sl (lock);
            if (status.phase == Phase::connected && now - lastStateReport > 1500)
            {
                // Reports stopped: asleep or out of range.
                status.phase = Phase::waiting;
                goneLocked();
            }
        }

        if (! any)
        {
            // Block briefly on the interface that carries state reports so we
            // react within a millisecond without spinning.
            if (activeDevice >= 0 && activeDevice < (int) devices.size())
            {
                const int r = hid_read_timeout (devices[(size_t) activeDevice].handle, buf, sizeof (buf), 4);
                if (r >= 2)
                    handleReport (buf, r, juce::Time::getMillisecondCounterHiRes());
            }
            else
            {
                wait (2);
            }
        }
    }
}

} // namespace scm
