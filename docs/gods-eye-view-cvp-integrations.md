# God's Eye View: CVP Integrations Catalog

A menu of cybersecurity integrations for the project, oriented around Cyber Verification Program (CVP) dual-use work. Companion to `gods-eye-view-master-plan.md` and `CLAUDE.md`.

This document is a candidate list for a defensive research project (CODIS). It is organizational, not operational: it describes what to build and the scope each thing runs against, not attack payloads.

---

## The one principle that governs everything here

**Scope authorization, not capability.** A scanner, fuzzer, or exploit PoC is legitimate against a target you own, administer, or are explicitly authorized to test. The same tool against a target you are not authorized on is out. This is the line for every item below, and it does not move.

Every active-tooling integration in this catalog must be built with scope-limiting baked in:

- An **allowlist of authorized ranges/targets** (your lab, your ranges, CTF boxes you are registered on, infrastructure you administer).
- **Refuse-by-default** on anything outside the allowlist. No "just this once" override in code.
- **Provenance logging** of what was run against what, so the authorized scope is auditable.

Treat scope-limiting as a first-class feature, not a guard bolted on later. It is both the ethical requirement and simply good tooling hygiene.

---

## What CVP does and does not change

- **Adjusts (for verified defensive users):** high-risk **dual-use** work such as vulnerability exploitation and offensive security tooling development. This is what most of this catalog draws on.
- **Does not adjust:** **prohibited use** (mass data exfiltration, ransomware development, etc.), which stays blocked regardless of verification.
- **Not affected by CVP at all:** the people-targeting items this project already ruled out. Those are not dual-use tooling; they are surveillance of individuals, which has no authorized-target model because the "targets" are people who cannot authorize anything.

### Permanently out (unchanged by verification)

- People-targeting: plate reading / ALPR on feeds, locating or profiling individuals, face/username-to-identity, people-search, breach-data lookups on arbitrary people.
- Prohibited use: mass exfiltration, ransomware, and anything with little to no legitimate defensive application.
- Acting against unauthorized third-party targets, with any tool.

---

## Category A: Scanning and exposure mapping

_Dual-use. Runs against authorized scope only. Plots onto the globe._

| Integration                  | What it is                                                                                                                     | Globe attachment                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Authorized-scope scanner** | Host/port/service discovery against your lab or a range you own. The dual-use centerpiece.                                     | Results stream onto the globe as they resolve: hosts as nodes, services as attributes, live discovery animation. |
| **Attack-surface diff**      | Snapshot your authorized external footprint over time; surface what changed (new open port, new exposed service, cert change). | Changes render as globe events with decay, like earthquakes for your own perimeter.                              |
| **Exposure grader**          | Pull your own external footprint (your Shodan org view, your certs, your DNS) and score it, weakest-first.                     | Heatmap / ranked panel; click an item to fly to the asset.                                                       |
| **Service fingerprinting**   | Banner/version identification on authorized hosts, mapped to known-issue context.                                              | Enriches each node's metadata card.                                                                              |

## Category B: Exploit and offensive tooling development

_Dual-use, the core CVP category. Standalone alongside the visualization; runs against lab/authorized targets._

| Integration                        | What it is                                                                                                                                     | Notes                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **PoC / exploit development**      | Build and test exploits against CODIS lab targets or intentionally-vulnerable VMs (DVWA, Metasploitable, HTB/THM boxes you are registered on). | The clearest fit for verification. Scope = boxes you are authorized on.      |
| **Fuzzing harness**                | Coverage-guided fuzzing of a target binary or service you own, with crash triage and minimization.                                             | Isolated; your own target.                                                   |
| **Technique lab + ATT&CK mapping** | Develop and test exploitation / evasion techniques in an isolated range, then map each to MITRE ATT&CK.                                        | Turns raw technique work into a teachable, mapped library for the club.      |
| **Payload development sandbox**    | Craft and iterate payloads against your own detonation targets.                                                                                | Isolated range only; pairs with Category C detection so you test both sides. |

## Category C: Detection and defense

_Mostly plain defensive work. This is `sentryd` territory and ties existing work into the project._

| Integration                  | What it is                                                                                           | Globe attachment                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Anomaly / IDS surfacing**  | Feed your own network telemetry in, surface outliers.                                                | Source geos as threat arcs; anomalies as decaying events. Direct bridge to sentryd.                            |
| **Honeypot telemetry layer** | Stand up honeypots you own, collect real attack telemetry, visualize origin / technique / frequency. | The legitimate, self-generated "watch the internet get attacked" layer. Real data, defensive, visually strong. |
| **Detection engineering**    | Author and test Sigma / YARA / Suricata rules against captured samples; track coverage over ATT&CK.  | Coverage matrix panel; alerts pivot to the globe.                                                              |
| **Log correlation console**  | SIEM-lite over your own logs; pivot from an alert to the asset.                                      | Feeds the in-app terminal / query console.                                                                     |

## Category D: Threat intelligence and asset OSINT

_Passive, public-source. Asset-scoped, never people-scoped._

| Integration                              | What it is                                                                                                                         | Globe attachment                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Multi-source asset enrichment**        | IOC in (IP / domain / cert / ASN / hash); correlate across CT, passive DNS, BGP, GreyNoise, and your own sightings; composite out. | The asset-scoped "triangulation" you wanted. Renders as a linked-node view. |
| **IOC pipeline**                         | Ingest public threat feeds, dedupe, geolocate, decay over time.                                                                    | A living threat layer with time-decay.                                      |
| **C2 / infrastructure mapping**          | Map C2 and related infrastructure from public malware reports as nodes.                                                            | Infrastructure graph on the globe. Metadata only, no detonation.            |
| **Threat-actor infrastructure tracking** | Track known-actor infrastructure from public reporting over time.                                                                  | Historical layer; pairs with the scrubber.                                  |

## Category E: CTF and training tooling

_Inherently scoped and authorized. Zero ambiguity._

| Integration                      | What it is                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **CTF ops dashboard**            | Track boxes, services, flags, and team progress for CODIS during competitions.                        |
| **Range / target manager**       | Spin up, track, and reset lab targets; visualize range topology.                                      |
| **Competition / skills tracker** | Tie into your security-competitions record; track what the club has practiced and where the gaps are. |

## Category F: Recon and topology

_Passive by default; active only against your own scope._

| Integration                       | What it is                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| **Passive recon aggregator**      | Everything learnable about an asset without touching it (public indexes only), one pane. |
| **Owned-network topology mapper** | 3D topology of infrastructure you own or administer.                                     |

---

## How this attaches to the three-pillar globe

The project already has: Pillar 1 (ambient physical-world globe), Pillar 2 (surveillance-infrastructure map), Pillar 3 (passive OSINT / analysis console). The CVP work slots in as an extension of Pillar 3 plus a new operational layer:

- **Passive items** (Category D, F) extend the existing OSINT console directly. Same query-console and asset-correlation subsystem.
- **Active items** (Category A, B) become a **scoped operations layer**: gated behind the authorized-target allowlist, with a clear visual and functional separation from the passive/ambient layers. This separation is itself a design principle, active tooling should look and behave differently in the UI so there is never ambiguity about what is reading versus acting.
- **Detection items** (Category C) feed both the globe (arcs, events) and the console (alerts, pivots), and connect your existing sentryd work.
- **CTF items** (Category E) can be their own dashboard mode.

---

## Build-in requirements for any active integration

Non-negotiable design elements whenever an integration touches a target rather than reads an index:

1. **Authorized-scope allowlist**, loaded from config, enforced at the tool boundary.
2. **Refuse-by-default** outside the allowlist. No runtime override.
3. **Provenance log**: what ran, against what, when, for auditability.
4. **UI separation**: active operations are visually and functionally distinct from passive/ambient layers.
5. **Isolation for detonation/exploit work**: lab targets and payload testing stay in an isolated range, never pointed at shared or production infrastructure.

---

## Suggested starting pair

Rather than boil the ocean, two that give the most for CODIS early:

1. **Honeypot telemetry layer (Category C).** Real, self-generated attack data. Defensive, unambiguous, visually excellent, and it produces genuine research output the club can present.
2. **Authorized-scope scanner with live globe plotting (Category A).** The dual-use centerpiece that verification most directly enables, and the piece that proves the scoped-operations layer and its allowlist enforcement.

Build those two and you have both the defensive-data story and the offensive-tooling story, each with scope-limiting proven, before expanding into exploit development and the rest.
