// Replays fixtures.txt (generated from the TypeScript implementation by
// scripts/gen-fixtures.ts) through the C++ port and fails on any difference.

#include "../Source/Core.h"

#include <cmath>
#include <cstdio>
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>

using namespace scm;

static int failures = 0;
static int noteOns = 0, pressures = 0, retriggers = 0;
static int lineNo = 0;

static void fail (const std::string& what)
{
    if (++failures <= 20)
        std::cerr << "line " << lineNo << ": " << what << "\n";
}

static VelocitySource velocitySource (const std::string& s)
{
    if (s == "lt") return VelocitySource::lt;
    if (s == "rt") return VelocitySource::rt;
    if (s == "lpad_pressure") return VelocitySource::lpadPressure;
    if (s == "rpad_pressure") return VelocitySource::rpadPressure;
    if (s == "speed") return VelocitySource::speed;
    if (s != "fixed") fail ("unknown velocity source " + s);
    return VelocitySource::fixed;
}

static std::vector<uint8_t> unhex (const std::string& s)
{
    std::vector<uint8_t> out;
    if (s == "-") return out;
    for (size_t i = 0; i + 1 < s.size(); i += 2)
        out.push_back ((uint8_t) std::strtoul (s.substr (i, 2).c_str(), nullptr, 16));
    return out;
}

static void expectOut (std::istringstream& in, const MidiList& got, const char* what)
{
    size_t n;
    in >> n;
    MidiList want;
    for (size_t i = 0; i < n; ++i)
    {
        // each message is its length, then that many bytes
        int len;
        in >> len;
        MidiMessage m { { 0, 0, 0 }, (uint8_t) len };
        for (int k = 0; k < len && k < 3; ++k)
        {
            int b;
            in >> b;
            m.bytes[k] = (uint8_t) b;
        }
        want.push_back (m);
    }
    auto print = [] (std::ostream& os, const MidiList& list)
    {
        for (auto& m : list)
        {
            os << " [";
            for (int k = 0; k < m.size; ++k) os << (k ? " " : "") << (int) m.bytes[k];
            os << "]";
        }
    };
    for (auto& m : got)
    {
        // Unused trailing bytes must be zero, or a 2-byte message would leak garbage.
        for (int k = m.size; k < 3; ++k)
            if (m.bytes[k] != 0) fail (std::string (what) + ": nonzero padding byte");
        if ((m.bytes[0] & 0xf0) == 0x90) ++noteOns;
        if ((m.bytes[0] & 0xf0) == 0xd0) ++pressures;
    }
    for (size_t i = 1; i < got.size(); ++i)
        if ((got[i - 1].bytes[0] & 0xf0) == 0x80 && got[i].bytes[0] == (got[i - 1].bytes[0] | 0x10)
            && got[i].bytes[1] == got[i - 1].bytes[1])
            ++retriggers;
    if (! (want == got))
    {
        std::ostringstream msg;
        msg << what << " mismatch: want";
        print (msg, want);
        msg << " got";
        print (msg, got);
        fail (msg.str());
    }
}

int main (int argc, char** argv)
{
    if (argc < 2) { std::cerr << "usage: parity fixtures.txt\n"; return 2; }
    std::ifstream file (argv[1]);
    if (! file) { std::cerr << "cannot open " << argv[1] << "\n"; return 2; }

    Engine engine;
    ControllerState state;
    TritonContext ctx;
    std::string solo;
    std::vector<Mapping> pending;
    size_t pendingCount = 0;
    double now = -1;
    int steps = 0;
    int optionChanges = 0, rumbles = 0;

    std::string line;
    while (std::getline (file, line))
    {
        ++lineNo;
        std::istringstream in (line);
        std::string tag;
        in >> tag;

        if (tag == "MAPPINGS")
        {
            in >> pendingCount;
            pending.clear();
        }
        else if (tag == "M")
        {
            Mapping m;
            std::string input, type, gate, release, velFrom;
            int enabled, toggle, invert, scale, mpe;
            in >> m.id >> input >> type >> enabled >> m.channel >> m.note >> m.velocity >> m.cc >> m.min >> m.max
               >> toggle >> m.grid >> m.speed >> invert >> m.deadzone >> m.curve >> m.smooth >> m.threshold >> gate >> release
               >> velFrom >> m.velMin >> m.gain >> m.repeat >> scale >> mpe >> m.bend;
            if (! in) { fail ("short mapping line"); continue; }
            m.velFrom = velocitySource (velFrom);
            m.scale = scale != 0;
            m.mpe = mpe != 0;
            m.enabled = enabled != 0;
            m.toggle = toggle != 0;
            m.invert = invert != 0;
            m.type = type == "note" ? MappingType::note : type == "cc" ? MappingType::cc
                   : type == "pitchbend" ? MappingType::pitchbend : MappingType::relative;
            const int b = buttonIndex (input);
            m.isAxis = b < 0;
            m.input = b >= 0 ? b : axisIndex (input);
            if (m.input < 0) { fail ("unknown input " + input); continue; }
            m.gate = gate == "-" ? -1 : buttonIndex (gate);
            m.releaseReset = release == "reset";
            pending.push_back (m);
        }
        else if (tag == "SETOUT")
        {
            if (pending.size() != pendingCount) fail ("mapping count");
            MidiList out;
            engine.setMappings (pending, out);
            expectOut (in, out, "setMappings");
        }
        else if (tag == "OPTS")
        {
            double tempo, root, scale;
            in >> tempo >> root >> scale;
            engine.setOptions (tempo, root, scale);
            ++optionChanges;
        }
        else if (tag == "RUMBLE")
        {
            double l, r;
            std::string hex;
            in >> l >> r >> hex;
            const auto want = unhex (hex);
            const auto got = buildRumbleReport (l, r);
            if (want.size() != got.size() || ! std::equal (want.begin(), want.end(), got.begin()))
                fail ("rumble report " + hex);
            ++rumbles;
        }
        else if (tag == "SOLO")
        {
            in >> solo;
            if (solo == "-") solo.clear();
        }
        else if (tag == "NEWCTX")
        {
            ctx = TritonContext();
        }
        else if (tag == "RECENTER")
        {
            ctx.recenter();
        }
        else if (tag == "RELEASEALL")
        {
            MidiList out;
            engine.releaseAll (out);
            expectOut (in, out, "releaseAll");
        }
        else if (tag == "R" || tag == "OTHER")
        {
            int id;
            std::string hex, type;
            in >> id >> hex >> type;
            const auto bytes = unhex (hex);
            const auto r = parseReport ((uint8_t) id, bytes.data(), bytes.size(), state, ctx);
            const char* names[] = { "unknown", "state", "battery", "wireless" };
            if (type != names[r.type]) fail ("report type: want " + type + " got " + names[r.type]);
            if (r.type == ParsedReport::battery)
            {
                int level, charging;
                in >> level >> charging;
                if (level != r.batteryLevel || (charging != 0) != r.charging) fail ("battery");
            }
            else if (r.type == ParsedReport::wireless)
            {
                int connected;
                in >> connected;
                if ((connected != 0) != r.connected) fail ("wireless");
            }
        }
        else if (tag == "B")
        {
            uint32_t mask;
            in >> mask;
            if (mask != state.buttonMask()) fail ("button mask");
        }
        else if (tag == "A")
        {
            for (size_t i = 0; i < (size_t) kNumAxes; ++i)
            {
                double want;
                in >> want;
                if (std::abs (want - state.axes[i]) > 1e-12)
                    fail (std::string ("axis ") + kAxes[i].id + ": want " + std::to_string (want) + " got " + std::to_string (state.axes[i]));
            }
        }
        else if (tag == "T")
        {
            in >> now;
        }
        else if (tag == "O")
        {
            MidiList out;
            engine.process (state, solo, now, out);
            expectOut (in, out, "process");
            ++steps;
        }
        else if (! tag.empty())
        {
            fail ("unknown tag " + tag);
        }
    }

    // The feature report must match what SDL's MaintainTritonState sends.
    const auto rep = buildSettingsReport (true);
    const uint8_t want[] = { 1, 0x87, 6, 9, 0, 0, 48, 0x18, 0 };
    for (size_t i = 0; i < rep.size(); ++i)
        if (rep[i] != (i < sizeof (want) ? want[i] : 0)) { fail ("settings report"); break; }

    std::cout << steps << " engine steps replayed (" << noteOns << " note-ons, " << retriggers << " repeat retriggers, "
              << pressures << " channel pressure, " << optionChanges << " option changes, " << rumbles
              << " rumble reports), " << failures << " mismatches\n";
    // A fixture that never exercises repeat or MPE would pass vacuously.
    const bool covered = steps > 1000 && retriggers > 50 && pressures > 50 && optionChanges > 1 && rumbles > 0;
    if (! covered) std::cerr << "fixture does not cover note repeat / MPE / options\n";
    return failures == 0 && covered ? 0 : 1;
}
