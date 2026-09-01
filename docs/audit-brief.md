# Audit and Remediation Brief

A task brief for Claude Code. Paste this as your instruction, or keep it at `docs/audit-brief.md` and tell Claude Code to follow it.

---

## Situation

All phases of this project are marked complete, but completion was declared without verification. In reality there is unfinished work, broken controls, placeholder/simulated data standing in for real feeds, and unpolished visuals. Your job is to find the gap between what is claimed done and what actually works, then close it.

Read `CLAUDE.md` and `docs/master-plan.md` first. The guardrails in `CLAUDE.md` remain in force during this work: polish and bug-fixing never introduce the out-of-scope items (people-targeting, prohibited-use, acting on unauthorized targets), and any CVP scope-limiting must be verified as actually enforced, not assumed.

## Prime directive: honesty over completion

- **Do not mark anything "working" that you have not run and observed working.** Reading the code and concluding it should work is exactly the failure that produced this situation.
- **Verify by running.** Start the app, load each layer, click each control, watch the network tab, and confirm real data arrives and renders. For active/CVP tooling, confirm the scope allowlist actually refuses out-of-scope targets.
- **No fake data left masquerading as real.** If a layer is fed by simulated, hardcoded, random, or demo data, that is a defect, not a feature. Either wire it to its real source (through the proxy) or, if the real source is genuinely unavailable, label it clearly as demo in both the UI and the audit, never leave it looking real.
- **When something cannot be made real right now, say so plainly** in the audit with the reason, rather than papering over it.

---

## Phase A: Audit (do this first, do not fix yet)

Produce `docs/AUDIT.md`. Enumerate every feature from the master plan and the CVP integrations catalog, and classify each with evidence:

- **Working** (verified by running: what you did, what you observed)
- **Partial** (works in part; state exactly what fails)
- **Stub / fake data** (renders but is not fed by its real source)
- **Broken** (present but errors or does nothing)
- **Missing** (not implemented)

For each non-working item, note the likely cause and the file(s) involved. Do not start fixing until the audit is written, so we have a baseline and a prioritized plan.

Cover at minimum: the globe/terrain/imagery, every data layer and its real feed, every UI control and toggle, click/tap-to-track, trails, metadata cards, presets, search/fly-to, the mobile "Around Me" flow, geolocation, cockpit mode, sensor shaders, the proxy and each of its six jobs, and every CVP integration that was built (including whether scope-limiting is truly enforced).

---

## Known problems to verify and prioritize (reported by the project owner)

Confirm each of these during the audit and treat them as high priority in remediation:

1. **The globe is low-resolution with no street-level detail, and you cannot zoom in to streets.** This is the single most important thing. Diagnose why. Likely causes to check in order: missing or invalid Cesium Ion access token (the default globe without Ion is low-res); no high-res imagery provider configured; no terrain provider beyond the ellipsoid; the Google Photorealistic 3D Tiles toggle not actually wired to a valid Google Maps Platform key; or the camera controller clamping zoom (check `screenSpaceCameraController.minimumZoomDistance` / `maximumZoomDistance` and any terrain-collision settings). Street-level 3D specifically requires either Google Photorealistic 3D Tiles or high-res imagery plus terrain. Make street-level zoom actually work, and make the free-vs-photorealistic terrain toggle switch providers for real.

2. **Many switches/toggles do nothing.** Audit every control. For each: does it actually add/remove or enable/disable its target, does its visual state reflect the real state, is the handler wired. Fix all dead controls.

3. **Demo/simulation data instead of real data.** Find every layer fed by fake data and wire it to its real feed through the proxy, or label it honestly. Verify real requests in the network tab.

4. **"Around Me" is wonky.** Fix the geolocation flow: clean permission request, correct camera framing at a sensible altitude, graceful fallback when denied or unavailable, and correct handling of the radius/viewport query that populates nearby layers.

5. **No "center on my location" button.** Add a dedicated locate-me control that flies the camera to the user's current position (requesting geolocation permission if needed, degrading gracefully if denied).

6. **Arcs, lines, triangles, and points look flat and basic.** Upgrade the visual treatment. Points/markers should use proper distance-scaled billboards or glyphs with depth and glow rather than flat dots. Arcs should be curved great-circle paths with height, a glow or gradient material, and animated flow where it suits the data (for example threat arcs). Lines should have glow and proper width and not clip through terrain (use depth-fail materials). Aim for a coherent, intentional visual language across the whole scene, not per-layer defaults. Follow the design tokens and constraints in the frontend styling guidance.

---

## Phase B: Remediation (after the audit)

Work in priority order:

1. **Terrain/imagery and street-level zoom** (item 1 above). Nothing else matters if the globe itself is unusable.
2. **Real data for every layer** (item 3). Kill the fake data.
3. **Dead controls** (item 2).
4. **Geolocation: Around Me + locate-me button** (items 4, 5).
5. **Visual polish of scene geometry** (item 6).
6. Everything else the audit flagged, worst-first.

After each fix, re-run and confirm the specific behavior before moving on. Update `docs/AUDIT.md` status as you go so it stays truthful.

---

## Standing rules for this work

- **Secrets stay behind the proxy.** If fixing a data feed tempts you to put a key in client code, that is a bug; route it through the proxy.
- **Mobile is the primary target (S25 Ultra).** Verify fixes on a mobile viewport, not just desktop. Respect the mobile constraints in `CLAUDE.md` (resolution scale, frame-rate caps, context-loss handling, touch pick tolerance).
- **Guardrails intact.** Do not implement any out-of-scope item while polishing. Verify CVP scope-limiting genuinely refuses out-of-scope targets rather than only appearing to.
- **No em dashes** in any docs or committed prose.
- **Do not silently downgrade scope.** If a feature genuinely cannot be completed, record it in the audit with the reason; do not hide it behind a stub.

---

## Deliverables

1. `docs/AUDIT.md`: the full classified inventory with evidence, kept truthful throughout.
2. The remediation itself, committed in logical steps with clear messages.
3. A short summary at the end: what was fake and is now real, what was broken and is now fixed, what remains genuinely incomplete and why.

Start with Phase A. Do not report the project complete until every item in the audit is either verified working or honestly documented as not.
