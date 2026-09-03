import { useState } from "react";

type Tier = "red" | "amber" | "green" | "purple" | "blue";

interface ManualTab {
  id: string;
  label: string;
  tier: Tier;
}

// Five tiers, same green/amber/red severity language the rest of the app
// already uses, plus purple (hands-on build/repair) and blue (deep
// reference) for the two kinds of content that don't fit "severity" at
// all. Order matters: red first because that's what someone opens this
// page for in an actual emergency.
const TABS: ManualTab[] = [
  { id: "emergency-start", label: "Start Here", tier: "red" },
  { id: "fast-troubleshooting", label: "Fast Troubleshooting", tier: "red" },
  { id: "contact-family", label: "Contacting the Family Group", tier: "red" },
  { id: "comms-checklist", label: "Comms Health Checklist", tier: "red" },

  { id: "station-setup", label: "Station Setup", tier: "amber" },
  { id: "winlink-setup", label: "Winlink", tier: "amber" },
  { id: "mesh-setup", label: "Mesh", tier: "amber" },
  { id: "js8call-setup", label: "JS8Call", tier: "amber" },
  { id: "rig-rotator-setup", label: "Rig & Rotator", tier: "amber" },
  { id: "backups-setup", label: "Backups", tier: "amber" },
  { id: "map-tiles-standalone", label: "Tactical Map Tiles", tier: "amber" },

  { id: "glossary", label: "Glossary", tier: "green" },
  { id: "tabs-overview", label: "What Each Tab Does", tier: "green" },
  { id: "band-reference", label: "Band & Frequency Reference", tier: "green" },

  { id: "antenna-building", label: "Antenna Building", tier: "purple" },
  { id: "antenna-repair", label: "Antenna & Hardware Repair", tier: "purple" },
  { id: "physical-vs-software", label: "Physical vs. Software", tier: "purple" },

  { id: "full-faq", label: "Full FAQ", tier: "blue" },
];

const TIER_ROWS: { tier: Tier; label: string }[] = [
  { tier: "red", label: "Critical — read this first" },
  { tier: "amber", label: "Setup & operation" },
  { tier: "green", label: "Reference" },
  { tier: "purple", label: "Build & repair" },
  { tier: "blue", label: "Deep FAQ" },
];

/** A tab whose content hasn't been written yet — staged deliberately,
 * not forgotten. Says so plainly rather than showing an empty page that
 * looks broken. */
function Stub({ note }: { note?: string }) {
  return (
    <div className="manual-stub">
      <p>This section hasn't been written yet.</p>
      {note && <p className="manual-stub-note">{note}</p>}
    </div>
  );
}

/** A labeled blank for information only Frank's family has — the real
 * agreed frequencies, schedule, and callsigns. Never fabricate plausible-
 * looking specifics here; a guessed frequency followed literally in a
 * real emergency is worse than an honest blank. */
function FillIn({ label }: { label: string }) {
  return (
    <div className="manual-fillin">
      <span className="manual-fillin-label">{label}:</span>
      <span className="manual-fillin-blank">___________________________</span>
    </div>
  );
}

function TabContent({ id }: { id: string }) {
  switch (id) {
    case "emergency-start":
      return (
        <>
          <p className="manual-lede">
            This page assumes you've never used WayStation before, the internet is not available, and you're
            doing this alone. Follow the numbers in order. Don't skip ahead.
          </p>
          <ol className="manual-steps">
            <li>Turn on the computer. If it's on battery, plug it in if you can — this may run for a long time.</li>
            <li>
              Open Citadel (the main dashboard) in a web browser, and click the <strong>Communications Hub</strong>{" "}
              tile. This opens WayStation directly — you don't need to find a separate icon for it. The very first
              time you do this, the browser may ask "Open this link with WayStation?" — say yes, and check "remember
              my choice" if it's offered so it doesn't ask again. If Citadel itself isn't available, WayStation can
              also be opened on its own the normal way for this computer (an icon or shortcut) — ask whoever set this
              machine up where that is, and write it down here for next time.
            </li>
            <li>
              You should see a dark screen with <strong>Waystation</strong> in gold at the top-left, and a column of
              links below it: Dashboard, EmComm, Messaging, Activity, Reference, Tools, Settings, User Manual. If you
              see that, the software is working.
            </li>
            <li>
              If a box titled <strong>"Welcome to WayStation"</strong> appears on top of that screen, this station
              has never been set up. Fill in a callsign and grid square if you know them — the setup only takes a
              minute and unlocks alerts and a few other panels — or press <strong>Skip for now</strong> at the
              bottom to get straight to sending messages. This box only appears once; it won't come back once a
              callsign is saved.
            </li>
            <li>
              Look at the bottom-left of that same left column. It should say <strong>CONNECTED</strong> in green.
              If it says <strong>CHECKING</strong> or is red, that's fine — it just means it's still figuring out
              the network. Give it a minute.
            </li>
            <li>
              Click <strong>Messaging</strong>. This is where you send and receive messages.
            </li>
            <li>
              Go to the <strong>Contacting the Family Group</strong> tab (still in this Critical row, to the right
              of this one) for exactly which button to press and what to type.
            </li>
          </ol>
          <p>
            If anything doesn't match what's described above, go to <strong>Fast Troubleshooting</strong>, the next
            tab over.
          </p>
        </>
      );

    case "fast-troubleshooting":
      return (
        <>
          <p className="manual-lede">
            Find what you're seeing below. Each one has the fastest fix, not the full explanation — for more detail
            once things are stable again, see <strong>Full FAQ</strong> in the Deep FAQ row.
          </p>
          <dl className="manual-symptom-list">
            <dt>Winlink says "Another Pat is running"</dt>
            <dd>
              A leftover copy from earlier is using the port. Press <strong>Restart Service</strong> on the Winlink
              panel — if it's a leftover from WayStation itself, this finds and replaces it automatically.
            </dd>
            <dt>The Mesh panel says "Disconnected"</dt>
            <dd>
              Check the Meshtastic radio is actually powered on and has a light/display active. Then press{" "}
              <strong>Reconnect</strong> on the Mesh panel. If it still won't connect, the radio may not be reachable
              at the address WayStation expects — see <strong>Physical vs. Software</strong> in the Build & Repair
              row.
            </dd>
            <dt>JS8Call panel says "not reachable"</dt>
            <dd>
              JS8Call is a separate program — WayStation does not start it for you. Open JS8Call itself, and in{" "}
              <em>JS8Call → File → Settings → Reporting</em>, make sure "Enable TCP Server API" is checked.
            </dd>
            <dt>The screen is blank, or nothing responds</dt>
            <dd>Close WayStation completely and reopen it. If that doesn't help, restart the computer.</dd>
            <dt>Weather/emergency alerts look wrong for your area</dt>
            <dd>
              Go to <strong>Settings → Station</strong> and check the grid square is the full 6 characters (like{" "}
              <code>DM94nx</code>), not just 4. A 4-character grid can cover 60+ km in the wrong direction.
            </dd>
            <dt>A message shows a red ✗ and "failed"</dt>
            <dd>
              The message did not get through. Try again — on Mesh this often means no other node was in range, or
              the wrong channel is selected. On Winlink/JS8Call it usually means the connection to that station
              dropped.
            </dd>
          </dl>
        </>
      );

    case "contact-family":
      return (
        <>
          <p className="manual-lede">
            WayStation has three ways to reach people with no internet, and they are not interchangeable — pick
            based on how far the other person is.
          </p>
          <p>
            <strong>Mesh (Meshtastic)</strong> — short range (typically under a few miles, farther with a good
            antenna or hills/repeater nodes helping). No license needed. Best for reaching people in the same house,
            same property, or same town. Go to <strong>Messaging → Mesh</strong>, make sure it says{" "}
            <strong>Connected</strong>, then type a message and press <strong>Send</strong>. Leave the channel
            dropdown on "All (Broadcast)" unless your family agreed on a specific channel number.
          </p>
          <p>
            <strong>Winlink or JS8Call</strong> — long range, can reach across states, but needs a working radio
            connected to the computer and an antenna actually up. This is the one for reaching family in a different
            town. Go to <strong>Messaging → Winlink</strong> (or JS8Call) and follow the same idea: check it's
            connected, then send.
          </p>
          <p className="manual-warn">
            The rest of this page is specific to your family's actual plan — fill it in ahead of time, while the
            grid is still up, and print a copy to keep next to the radio. Guessing at this during a real emergency
            is exactly what this page is meant to prevent.
          </p>
          <div className="manual-fillin-block">
            <FillIn label="Primary mode to try first" />
            <FillIn label="Backup mode if that fails" />
            <FillIn label="Agreed frequency (if using radio)" />
            <FillIn label="Scheduled check-in time(s)" />
            <FillIn label="Family callsigns / node names to expect" />
            <FillIn label="If no one answers, next step" />
          </div>
        </>
      );

    case "comms-checklist":
      return (
        <>
          <p className="manual-lede">
            Run this periodically — weekly is reasonable — so a problem is caught while it's still an inconvenience,
            not discovered during an actual emergency.
          </p>
          <ol className="manual-steps">
            <li>Power on and confirm WayStation opens normally (see Start Here).</li>
            <li>Go to Settings → Diagnostics. Everything should say healthy or show what to do if not.</li>
            <li>On Messaging, confirm Winlink shows "Pat running" and Mesh shows "Connected."</li>
            <li>Send an actual test message on each mode you rely on — to a family member, or to yourself.</li>
            <li>Confirm the message shows delivered, not just sent, when the other side is reachable.</li>
            <li>
              Walk outside and look at the antenna and any visible cable/connectors — check for anything torn, bent,
              disconnected, or full of water.
            </li>
            <li>Check backup power (battery/solar/generator, whatever this station relies on) actually has charge.</li>
            <li>
              Settings → Diagnostics → <strong>Back Up Now</strong> — save a fresh copy of everything logged.
            </li>
          </ol>
        </>
      );

    case "station-setup":
      return (
        <>
          <p>Most of WayStation needs nothing extra — just this computer. Specific panels need specific software:</p>
          <dl>
            <dt>Winlink</dt>
            <dd>
              Needs <strong>Pat</strong> (a free Winlink client) installed separately. WayStation launches and
              manages it for you, but you still have to create a Winlink account — see the Winlink tab.
            </dd>
            <dt>JS8Call</dt>
            <dd>
              Needs <strong>JS8Call</strong> installed AND running on its own — WayStation does not launch it. You
              must also manually turn on JS8Call's TCP API in JS8Call's own settings (off by default).
            </dd>
            <dt>Mesh</dt>
            <dd>
              Needs a <strong>Meshtastic</strong> node reachable over TCP, or <code>meshtasticd</code> running on
              this computer. WayStation connects as a client; it doesn't launch anything.
            </dd>
            <dt>Rig Control</dt>
            <dd>
              Needs <code>rigctld</code> (part of Hamlib) running against your radio. WayStation connects to one
              you're already running and never starts its own, since only one program can hold a serial port.
            </dd>
            <dt>Rotator Control</dt>
            <dd>
              Same relationship, via <code>rotctld</code> — WayStation connects, never starts it.
            </dd>
            <dt>Repeater Lookup</dt>
            <dd>Needs a free RepeaterBook API token, requested at repeaterbook.com and pasted into Settings.</dd>
            <dt>Tactical Map</dt>
            <dd>
              Works automatically if this computer is running Citadel. Running WayStation on its own? See the{" "}
              <strong>Tactical Map Tiles</strong> tab for getting your own map tiles working the same way.
            </dd>
          </dl>
          <p>
            Go to <strong>Settings → Station</strong> and enter your <strong>callsign</strong> and{" "}
            <strong>grid square</strong>. A few panels (DX Cluster, Reception Reports, Active Alerts) need these.
          </p>
          <p>
            <strong>Use your 6-character grid square (e.g. DM94nx), not the 4-character one.</strong> A 4-character
            grid covers roughly 111 × 180 km — several counties. Weather alerts are chosen by that location, so a
            4-character grid can show you alerts for a county 60 km away and miss your own. Six characters narrows
            it to about 2–3 km.
          </p>
        </>
      );

    case "winlink-setup":
      return (
        <>
          <p>Three things have to be true, and it's easy to stop after the first:</p>
          <p>
            <strong>1. Install Pat.</strong> WayStation doesn't bundle it. On Linux the binary can go in{" "}
            <code>~/.local/bin/</code> with no root needed.
          </p>
          <p>
            <strong>2. Create a Winlink account.</strong> Your callsign is your account, but it must be registered
            and given a password first. Run this in a terminal — it offers a guided setup that creates the account
            for you:
            <code className="manual-cmd">pat --config ~/.local/share/waystation/pat/config.json configure</code>
            The <code>--config</code> part is not optional. Pat's own default config is somewhere else, so leaving
            it off edits the wrong file — everything appears to save, and nothing changes.
          </p>
          <p>
            <strong>3. Press Restart Service</strong> on the Winlink panel. Pat only reads its config at startup, so
            a running Pat won't know about an account you just created.
          </p>
          <p>
            <strong>Where is Pat?</strong> It has no window or icon — it runs invisibly and talks over the network.
            Use the "Open Pat's interface" link on the Winlink panel to reach it. That page is for reading and
            sending mail only; account setup happens through the command above. To test without a radio, use
            Action → Connect → telnet there.
          </p>
        </>
      );

    case "mesh-setup":
    case "js8call-setup":
    case "rig-rotator-setup":
      return <Stub note="What each panel needs is already listed under Station Setup — a full walkthrough for this one is still to come." />;

    case "backups-setup":
      return (
        <p>
          Settings → Diagnostics → <strong>Back Up Now</strong> saves a complete copy of everything you've logged
          to a file you choose. Worth doing on a regular schedule (see Comms Health Checklist) and before any update
          or reinstall — there's no in-app restore yet, so a backup only helps if you actually make one.
        </p>
      );

    case "map-tiles-standalone":
      return (
        <>
          <p className="manual-lede">
            Running WayStation alongside Citadel? Skip this page — the Tactical Map (EmComm tab) finds
            Citadel's own local map tiles automatically, no setup needed. This is only for WayStation running
            on its own, without Citadel.
          </p>
          <p>
            Without either, the map still works over the internet (OpenFreeMap) whenever you have a
            connection — but the whole point of local tiles is a map that works with no internet at all.
          </p>
          <p>
            <strong>1. Get the pmtiles tool.</strong> A single program file, no installer — download the
            right one for your system from{" "}
            <a href="https://github.com/protomaps/go-pmtiles/releases" target="_blank" rel="noreferrer">
              github.com/protomaps/go-pmtiles/releases
            </a>
            .
          </p>
          <p>
            <strong>2. Find your area's coordinates.</strong> Go to{" "}
            <a href="https://bboxfinder.com" target="_blank" rel="noreferrer">
              bboxfinder.com
            </a>
            , draw a box around the area you need (your county, or your whole family's coverage area — a
            bigger box means a bigger download), and copy the four numbers it gives you.
          </p>
          <p>
            <strong>3. Download just your area.</strong> Protomaps publishes a free, current map of the whole
            world — you only pull out your piece of it:
            <code className="manual-cmd">
              pmtiles extract https://build.protomaps.com/&lt;date&gt;.pmtiles comms_base.pmtiles
              --bbox=&lt;your,four,numbers&gt;
            </code>
            Check{" "}
            <a href="https://maps.protomaps.com/builds" target="_blank" rel="noreferrer">
              maps.protomaps.com/builds
            </a>{" "}
            for the current date to use in that URL. Name the output file exactly{" "}
            <code>comms_base.pmtiles</code> — that's what WayStation looks for. This can take a while
            depending on your area's size and connection.
          </p>
          <p>
            <strong>4. Serve the file locally.</strong> WayStation needs the file reachable over a local
            address with the right headers, not just sitting on disk. The simplest reliable way is a small
            nginx setup: install nginx, then point a config at the folder holding your file:
            <code className="manual-cmd">
              {"location /tiles/ {\n    root /path/to/your/tiles/folder;\n    add_header Access-Control-Allow-Origin *;\n    add_header Access-Control-Expose-Headers 'Content-Range, Content-Length, Accept-Ranges';\n}"}
            </code>
          </p>
          <p>
            <strong>5. Point WayStation at it.</strong> Settings → Station → <strong>Citadel map server</strong>
            , enter <code>127.0.0.1:&lt;your port&gt;</code>. The map checks this first every time it opens,
            and only falls back to the internet if nothing answers there.
          </p>
          <p>
            A separate terrain/elevation file isn't required — the map works fine without one, just without
            hillshading. If you want it anyway, extract a second file the same way and name it{" "}
            <code>tactical_terrain.pmtiles</code> in the same folder.
          </p>
        </>
      );

    case "glossary":
      return (
        <dl>
          <dt>Callsign</dt>
          <dd>Your personal ID as a licensed ham operator (e.g. KJ4ESQ) — how you identify yourself on the air.</dd>
          <dt>Grid square</dt>
          <dd>
            A short location code used worldwide instead of an address. Each pair of characters narrows it down:
            DM94 is about 111 × 180 km, DM94nx is about 5 × 5 km.
          </dd>
          <dt>Band / Mode</dt>
          <dd>Band = a slice of radio frequencies (e.g. "20 meters"). Mode = how a signal is encoded (voice, Morse, digital).</dd>
          <dt>DX / Spot</dt>
          <dd>DX = a distant/interesting station. A spot = a report that someone just heard a station on a frequency.</dd>
          <dt>SFI / K-index / Bz</dt>
          <dd>Numbers describing the sun's activity and its effect on radio propagation — color-coded green/amber/red so you don't need the physics.</dd>
          <dt>UTC / Zulu</dt>
          <dd>The single time zone hams use worldwide to avoid confusion — same as GMT.</dd>
          <dt>EmComm</dt>
          <dd>Emergency Communications — using ham radio to support first responders and shelters when normal comms are down.</dd>
          <dt>Net / Net Control</dt>
          <dd>A scheduled, organized radio conversation with one operator managing who talks when.</dd>
          <dt>Winlink / JS8Call</dt>
          <dd>Winlink = email over ham radio. JS8Call = a slow, very-long-range text chat mode for weak signals.</dd>
          <dt>Mesh / Meshtastic</dt>
          <dd>
            A small radio network where each node relays for the others, so messages hop node to node with no
            tower and no internet. No license needed — it uses unlicensed spectrum, not the ham bands.
          </dd>
          <dt>QSO / ADIF</dt>
          <dd>A QSO is a two-way contact with another station. ADIF is the standard log file format every other logging program reads.</dd>
          <dt>POTA</dt>
          <dd>Parks on the Air — operators activate temporary stations in parks; others "hunt" (contact) them.</dd>
          <dt>SNR</dt>
          <dd>Signal-to-Noise Ratio, in dB — how much stronger a signal is than the background noise. Higher is better.</dd>
        </dl>
      );

    case "tabs-overview":
      return (
        <dl>
          <dt>Dashboard</dt>
          <dd>At-a-glance: world map with day/night and live pins, rig control, space weather, and active weather alerts.</dd>
          <dt>EmComm</dt>
          <dd>Net control check-in, ICS-213/309 message forms, resource tracking, "prepare for offline."</dd>
          <dt>Messaging</dt>
          <dd>The three ways to get a message out without the internet: Winlink, JS8Call, and mesh.</dd>
          <dt>Activity</dt>
          <dd>What's on the air: contests, who's hearing you, POTA spots, DX cluster, satellite passes, your QSO log.</dd>
          <dt>Reference</dt>
          <dd>Static cheat sheets (frequencies, band plan), your own channel list, repeater lookup, your WebSDR bookmarks — none of this needs the internet.</dd>
          <dt>Tools</dt>
          <dd>Bearing/distance, antenna length, dB, SWR, and RF power density calculators.</dd>
          <dt>Settings</dt>
          <dd>Your station profile and diagnostics.</dd>
          <dt>User Manual</dt>
          <dd>This page.</dd>
        </dl>
      );

    case "band-reference":
      return <Stub />;

    case "antenna-building":
      return (
        <>
          <p className="manual-lede">
            For real dimensions, use <strong>Tools → Antenna Calculator</strong> — it uses the same standard
            formulas as everywhere else in ham radio (468/f for a dipole, 234/f for a quarter-wave vertical, in
            feet, f in MHz). This page is the building itself: what a beginner needs to actually put one up.
          </p>
          <p className="manual-warn">
            <strong>Before anything else: never put wire anywhere near a power line.</strong> Not "probably far
            enough" — if a fallen antenna could possibly reach a power line, pick a different spot. This is the
            one antenna-building mistake that kills people.
          </p>
          <p>
            <strong>Start with a half-wave dipole.</strong> It's the simplest design that actually works well,
            cheap to build, and forgiving of a mediocre location — a fine first antenna and a fine permanent one.
          </p>
          <ol className="manual-steps">
            <li>Get the total length and each-leg length from the Antenna Calculator for your target frequency.</li>
            <li>
              Cut two lengths of wire (stranded copper, 14–18 AWG, insulated holds up better outdoors) to the
              "each leg" measurement, adding a few extra inches on each end to wrap around the end insulators.
            </li>
            <li>Attach each wire to a center insulator — this is also where the feedline (coax) connects.</li>
            <li>Attach an end insulator and support rope/cord to the far end of each leg.</li>
            <li>
              Put a <strong>1:1 current balun</strong> at the center feedpoint if you have one. Without it, the
              outside of your coax shield can radiate too, which throws off SWR readings and can cause RF to show
              up inside the shack.
            </li>
            <li>
              Hoist it up — flat and level between two supports ("flat-top"), or one end high and the other low
              ("inverted-V") if you only have one tall support. Either works; flat-top is quieter electrically,
              inverted-V needs less space.
            </li>
            <li>
              <strong>Check SWR before transmitting at real power.</strong> A bad match can damage a radio,
              especially on transmit modes that don't tolerate it well. Trim the legs a little at a time if it's
              off — cutting off wire is easy, adding it back isn't, so trim less than you think you need to.
            </li>
          </ol>
          <p>
            <strong>A step up: the J-Pole.</strong> No ground plane or elevated feedpoint needed, and it stands on
            its own (copper pipe) or rolls up (twin-lead/ladder-line), which makes it a good VHF/UHF go-kit
            antenna. Same idea as above — get radiator and stub lengths from the calculator, and check SWR before
            real power.
          </p>
          <p>
            <strong>Portable option: end-fed half-wave (EFHW).</strong> Feeds from one end instead of the center,
            so it packs down to a single line with no center weight — good for a go-bag. It needs an impedance-
            matching transformer (commonly a 49:1 "unun") at the feedpoint. Winding your own transformer correctly
            takes real RF experience to get right; a pre-built EFHW matching unit from a known antenna maker is a
            more honest starting point than guessing at turns and core material for a first build.
          </p>
          <p>Basic kit worth keeping on hand for any of these: an SWR/power meter, wire cutters/strippers, a soldering iron or a proper crimp tool, heat-shrink tubing, and self-amalgamating (rubber) tape for weatherproofing every outdoor connection.</p>
        </>
      );

    case "antenna-repair":
      return (
        <>
          <p className="manual-lede">
            Most antenna problems are one of a handful of things. Work through these before assuming the antenna
            itself needs replacing.
          </p>
          <dl>
            <dt>SWR has crept up slowly over weeks or months</dt>
            <dd>
              Almost always water intrusion — a nicked or cracked coax jacket lets water wick into the braid over
              time, which changes the cable's characteristics gradually rather than all at once. Inspect the full
              visible run for cracks, and check both connectors for any green or white corrosion.
            </dd>
            <dt>SWR jumped suddenly, especially right after wind or rain</dt>
            <dd>
              Check for a physically loose or knocked connector first — this is the most common sudden cause and
              the easiest to fix. Also look for a wire that's come off an insulator or a snapped element.
            </dd>
            <dt>SWR changes when you wiggle the cable near the connector</dt>
            <dd>A damaged connector or a broken strand inside the cable right at that point. Re-terminate the connector; if it's mid-run, that section of coax needs replacing, not just taping over.</dd>
            <dt>Rotator or mast hardware</dt>
            <dd>Check U-bolts and clamps are still torqued, and guy wires (if any) are still tensioned — both loosen over time from wind and thermal cycling, not just from a single storm.</dd>
          </dl>
          <p>
            <strong>A simple continuity test</strong> with a multimeter, at the radio end with the antenna
            disconnected: center pin to center pin should read continuity end-to-end; shield to shield should
            too; but center pin to shield should read <em>no</em> continuity. A short there means water intrusion
            or a crushed connector somewhere in the run.
          </p>
          <p>
            Coax with a compromised outer jacket that's been exposed to weather should be replaced or have that
            section cut out and re-spliced — taping over a nick doesn't stop water that's already wicking in
            along the braid. PL-259 connectors are cheap and simple enough to re-terminate yourself; worth
            learning rather than always buying a whole new cable run over one bad end.
          </p>
        </>
      );

    case "physical-vs-software":
      return (
        <>
          <p className="manual-lede">
            Same symptom — "it's not working" — can mean a cable problem or a settings problem, and they need
            completely different fixes. This is how to tell which one you're looking at before you start
            troubleshooting the wrong layer.
          </p>
          <p>
            <strong>The general rule:</strong> if the radio/node's own display or lights show real activity
            independent of the computer, the hardware side is alive and the problem is upstream in WayStation or
            its configuration. If the hardware itself shows no sign of life — no lights, no display, no
            activity — that's power or a physical connection, and no amount of settings changes in WayStation will
            fix it.
          </p>
          <dl>
            <dt>Mesh panel says "Disconnected"</dt>
            <dd>
              Node's own screen shows it's on and talking to other nodes? Software-side — check the mesh host
              address in Settings and that <code>meshtasticd</code> (if used) is actually running. Node's screen
              is blank or off? Hardware — check power first.
            </dd>
            <dt>Rig control isn't responding</dt>
            <dd>
              Settings → Diagnostics shows <code>rigctld</code> healthy? The software link is fine — check the
              radio is actually powered on and the data cable is seated, not the WayStation configuration. If
              Diagnostics itself shows the connection unhealthy, that's software/config — confirm{" "}
              <code>rigctld</code> is running and pointed at the right serial port.
            </dd>
            <dt>A band that's normally busy is just quiet</dt>
            <dd>
              This is often neither — band conditions genuinely change hour to hour. Check Space Weather (K-index,
              solar wind) before assuming anything is broken.
            </dd>
            <dt>SWR spiked right after a storm</dt>
            <dd>
              Physical, almost always — see <strong>Antenna & Hardware Repair</strong> for what to check first.
            </dd>
          </dl>
          <p>
            For the software-side quick fixes themselves, see <strong>Fast Troubleshooting</strong> in the
            Critical row.
          </p>
        </>
      );

    case "full-faq":
      return (
        <>
          <p>
            <strong>A panel says "Loading..." or looks empty — is it broken?</strong> Probably not. Some panels need
            your callsign/grid set first; others are just waiting on their first scheduled check-in. Check{" "}
            <strong>Settings → Diagnostics</strong> — anything genuinely broken says so there, with what to do.
          </p>
          <p>
            <strong>Winlink says "Another Pat is running."</strong> A leftover Pat from an earlier session is using
            the port. Press Restart Service — if it's a WayStation leftover, that finds and replaces it
            automatically now. Still there after that means it's a Pat you started some other way; quit that one
            directly first.
          </p>
          <p>
            <strong>My weather alerts are for the wrong area.</strong> Almost certainly a 4-character grid square.
            Enter your 6-character one instead.
          </p>
          <p>
            <strong>Does this store anything about me online?</strong> No. Everything you enter stays in a local
            database file on your own computer. WayStation only fetches public data — it never uploads anything.
          </p>
          <p>
            <strong>How do I back up my data?</strong> See the Backups tab in Setup & Operation.
          </p>
        </>
      );

    default:
      return <Stub />;
  }
}

function UserManualPanel() {
  const [activeTab, setActiveTab] = useState("emergency-start");

  return (
    <div className="panel-user-manual">
      <div className="manual-tab-rows">
        {TIER_ROWS.map((row) => (
          <div className={`manual-tab-row manual-tier-${row.tier}`} key={row.tier}>
            <span className="manual-tier-label">{row.label}</span>
            <div className="manual-tab-buttons">
              {TABS.filter((t) => t.tier === row.tier).map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`manual-tab-button ${activeTab === t.id ? "active" : ""}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="manual-tab-content">
        <TabContent id={activeTab} />
      </div>
    </div>
  );
}

export default UserManualPanel;
