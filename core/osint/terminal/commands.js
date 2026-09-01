// In-app terminal command layer (Pillar 3, final piece). A command palette that
// DRIVES THE APP and runs the passive lookups already built. GUARDRAIL from the
// master plan: it commands the app and reads public indexes only; it never sends
// traffic at a remote host. No scanning, no packets at targets: `query`/`correlate`
// route through the same passive RIPEstat/Shodan reads the console uses.
//
// Parsing is pure and unit-tested; side effects go through the injected `ctx`
// facade (layers, camera, search, presets, lookups), so this stays testable.

export function parseCommandLine(line) {
  const t = String(line ?? '').trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

const numRe = /^-?\d+(?:\.\d+)?$/;

// "goto 33.7,-116.3", "goto 33.7 -116.3 5000", or "goto <place words>".
export function parseGoto(args) {
  if (!args.length) return null;
  const joined = args.join(' ');
  const m = joined.match(
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?$/,
  );
  if (m) {
    return {
      kind: 'coords',
      latitude: +m[1],
      longitude: +m[2],
      altitude: m[3] ? +m[3] : undefined,
    };
  }
  if (args.length >= 2 && numRe.test(args[0]) && numRe.test(args[1])) {
    return {
      kind: 'coords',
      latitude: +args[0],
      longitude: +args[1],
      altitude: args[2] && numRe.test(args[2]) ? +args[2] : undefined,
    };
  }
  return { kind: 'place', query: joined };
}

export function createCommands(ctx) {
  const reg = {};
  const def = (name, usage, help, run) => {
    reg[name] = { name, usage, help, run };
  };

  def('help', 'help', 'list commands', () => [
    'commands:',
    ...Object.values(reg).map((c) => `  ${c.usage.padEnd(30)} ${c.help}`),
  ]);

  def('track', 'track <query>', 'find + track an entity in the active layers', (args) => {
    if (!args.length) return ['usage: track <callsign|name|id>'];
    const label = ctx.track(args.join(' '));
    return label ? [`tracking ${label}`] : ['no matching entity in the active layers'];
  });

  def('layer', 'layer <id> [on|off|toggle]', 'switch a layer', (args) => {
    if (!args.length) {
      return [
        'usage: layer <id> [on|off|toggle]',
        `layers: ${ctx
          .listLayers()
          .map((l) => l.key)
          .join(', ')}`,
      ];
    }
    const key = args[0];
    const action = args[1] ?? 'toggle';
    if (!['on', 'off', 'toggle'].includes(action)) return [`unknown action "${action}"`];
    return ctx.setLayer(key, action)
      ? [`layer ${key} ${action}`]
      : [`unknown layer "${key}"`];
  });

  def('layers', 'layers', 'list layers + state', () => [
    'layers:',
    ...ctx.listLayers().map((l) => `  ${l.on ? '[on] ' : '[off]'} ${l.key}`),
  ]);

  def('goto', 'goto <lat,lon> | <place>', 'fly the camera', async (args) => {
    const g = parseGoto(args);
    if (!g) return ['usage: goto <lat,lon> | goto <place>'];
    if (g.kind === 'coords') {
      if (Math.abs(g.latitude) > 90 || Math.abs(g.longitude) > 180)
        return ['coordinates out of range'];
      ctx.goto({ latitude: g.latitude, longitude: g.longitude, altitude: g.altitude });
      return [`flying to ${g.latitude}, ${g.longitude}`];
    }
    if (!ctx.geocode) return ['place lookup unavailable (no geocoder configured)'];
    try {
      const places = await ctx.geocode(g.query);
      if (!places?.length) return [`no place found for "${g.query}"`];
      const p = places[0];
      ctx.goto({ latitude: p.latitude, longitude: p.longitude, altitude: 150_000 });
      return [`flying to ${p.name}`];
    } catch {
      return ['place lookup failed'];
    }
  });

  def('query', 'query <ip|domain|asn>', 'passive OSINT lookup + plot', async (args) => {
    if (!args.length) return ['usage: query <ip|domain|asn>'];
    const r = await ctx.query(args.join(' '));
    return r.error ? [`query: ${r.error}`] : [`plotted ${r.kind} ${r.value}`];
  });

  def(
    'correlate',
    'correlate <ip|domain|asn>',
    'multi-source correlation + plot',
    async (args) => {
      if (!args.length) return ['usage: correlate <ip|domain|asn>'];
      const r = await ctx.correlate(args.join(' '));
      return r.error ? [`correlate: ${r.error}`] : [`correlated ${r.kind} ${r.value}`];
    },
  );

  def('preset', 'preset <name>', 'apply a preset', (args) => {
    if (!args.length) {
      return [
        'usage: preset <name>',
        `presets: ${ctx
          .listPresets()
          .map((p) => p.id)
          .join(', ')}`,
      ];
    }
    return ctx.applyPreset(args[0])
      ? [`preset ${args[0]}`]
      : [`unknown preset "${args[0]}"`];
  });

  def('presets', 'presets', 'list presets', () => [
    'presets:',
    ...ctx.listPresets().map((p) => `  ${p.id} — ${p.label}`),
  ]);

  return {
    commands: reg,
    async run(line) {
      const parsed = parseCommandLine(line);
      if (!parsed) return [];
      const c = reg[parsed.name];
      if (!c) return [`unknown command: ${parsed.name} (try "help")`];
      try {
        return await c.run(parsed.args, ctx);
      } catch (e) {
        return [`error: ${String(e?.message || e)}`];
      }
    },
  };
}
