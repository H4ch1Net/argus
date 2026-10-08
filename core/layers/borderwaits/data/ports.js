// US land ports of entry with a bundled position, for placing the CBP and CBSA
// border wait times on the map (neither feed carries coordinates).
//
// Positions were written from knowledge of each crossing (the US-side
// inspection plaza, or the bridge for river crossings), with no network to
// check them: `confidence: 'high'` means believed within about 0.005 degrees
// (a few hundred metres), 'medium' within about 0.01 degrees (about a
// kilometre). Ports not listed (smaller crossings, San Luis II, Eagle Pass
// Bridge II, Tornillo, Alexandria Bay, the Maine and Montana crossings, ...)
// stay off the map: the layer counts them as "without a bundled location"
// rather than guess.
//
// Matching, on names normalized to lower case words ("B&M" -> "b and m"):
// `cbp` is a list of matchers { port, crossing?, skip? } tested against CBP's
// port_name and crossing_name (port must match; crossing, when given, must
// match; skip, when given, must not); the first entry that matches wins, so
// specific crossings come before their port's catch-all. `cbsa` is tested
// against the CBSA office and location (the Canadian side of the same crossing).

const P = (id, name, border, state, lat, lon, confidence, cbp, cbsa = null) =>
  Object.freeze({ id, name, border, state, lat, lon, confidence, cbp, cbsa });

/** @type {ReadonlyArray<{ id: string, name: string, border: 'mx'|'ca', state: string,
 *   lat: number, lon: number, confidence: 'high'|'medium',
 *   cbp: Array<{ port: RegExp, crossing?: RegExp, skip?: RegExp }>, cbsa: RegExp|null }>} */
export const PORTS = Object.freeze([
  // --- US-Mexico border, west to east ---
  P('san-ysidro', 'San Ysidro', 'mx', 'CA', 32.5423, -117.0298, 'high', [
    { port: /^san ysidro/ },
  ]),
  P('otay-mesa', 'Otay Mesa', 'mx', 'CA', 32.5497, -116.9383, 'high', [
    { port: /^otay mesa/ },
  ]),
  P('tecate', 'Tecate', 'mx', 'CA', 32.5766, -116.6273, 'high', [{ port: /^tecate/ }]),
  P('calexico-east', 'Calexico East', 'mx', 'CA', 32.6731, -115.3878, 'medium', [
    { port: /^calexico east/ },
    { port: /^calexico/, crossing: /\beast\b/ },
  ]),
  P('calexico-west', 'Calexico West', 'mx', 'CA', 32.6648, -115.4989, 'high', [
    { port: /^calexico/, skip: /\beast\b/ },
  ]),
  P('andrade', 'Andrade', 'mx', 'CA', 32.7186, -114.7286, 'medium', [
    { port: /^andrade/ },
  ]),
  P('san-luis', 'San Luis I', 'mx', 'AZ', 32.4857, -114.7822, 'high', [
    { port: /^san luis/, skip: /\bii\b|\b2\b|commercial/ },
  ]),
  P('lukeville', 'Lukeville', 'mx', 'AZ', 31.8806, -112.8167, 'high', [
    { port: /^lukeville/ },
  ]),
  P('sasabe', 'Sasabe', 'mx', 'AZ', 31.4825, -111.5442, 'medium', [{ port: /^sasabe/ }]),
  P('nogales-deconcini', 'Nogales, DeConcini', 'mx', 'AZ', 31.3327, -110.9419, 'high', [
    { port: /^nogales/, crossing: /deconcini/ },
  ]),
  P('nogales-mariposa', 'Nogales, Mariposa', 'mx', 'AZ', 31.3366, -110.9746, 'medium', [
    { port: /^nogales/, crossing: /mariposa/ },
  ]),
  P('naco', 'Naco', 'mx', 'AZ', 31.3336, -109.9483, 'high', [{ port: /^naco/ }]),
  P('douglas', 'Douglas (Raul H. Castro)', 'mx', 'AZ', 31.3341, -109.5601, 'high', [
    { port: /^douglas/ },
  ]),
  P('columbus', 'Columbus', 'mx', 'NM', 31.7839, -107.6356, 'high', [
    { port: /^columbus/ },
  ]),
  P('santa-teresa', 'Santa Teresa', 'mx', 'NM', 31.784, -106.6792, 'medium', [
    { port: /^santa teresa/ },
  ]),
  P('el-paso-pdn', 'El Paso, Paso del Norte', 'mx', 'TX', 31.7487, -106.4876, 'high', [
    { port: /^el paso/, crossing: /paso del norte|\bpdn\b|santa fe/ },
  ]),
  P('el-paso-stanton', 'El Paso, Stanton DCL', 'mx', 'TX', 31.7526, -106.4737, 'medium', [
    { port: /^el paso/, crossing: /stanton|\bdcl\b|good neighbor/ },
  ]),
  P(
    'el-paso-bota',
    'El Paso, Bridge of the Americas',
    'mx',
    'TX',
    31.7645,
    -106.451,
    'high',
    [{ port: /^el paso/, crossing: /\bbota\b|bridge of the americas|cordova/ }],
  ),
  P('el-paso-ysleta', 'El Paso, Ysleta', 'mx', 'TX', 31.6726, -106.3364, 'high', [
    { port: /^el paso/, crossing: /ysleta|zaragoza/ },
  ]),
  P('presidio', 'Presidio', 'mx', 'TX', 29.5617, -104.3722, 'medium', [
    { port: /^presidio/ },
  ]),
  P('del-rio', 'Del Rio', 'mx', 'TX', 29.3271, -100.9275, 'medium', [
    { port: /^del rio/ },
  ]),
  P('eagle-pass-1', 'Eagle Pass, Bridge I', 'mx', 'TX', 28.7077, -100.5115, 'high', [
    { port: /^eagle pass/, crossing: /\bbridge i\b|\bbridge 1\b/ },
  ]),
  P(
    'laredo-1',
    'Laredo, Gateway to the Americas',
    'mx',
    'TX',
    27.4999,
    -99.5073,
    'high',
    [
      {
        port: /^laredo/,
        crossing: /\bbridge i\b|\bbridge 1\b|gateway to the americas|convent/,
      },
    ],
  ),
  P('laredo-2', 'Laredo, Juarez-Lincoln', 'mx', 'TX', 27.5017, -99.5026, 'high', [
    { port: /^laredo/, crossing: /\bbridge ii\b|\bbridge 2\b|juarez|lincoln/ },
  ]),
  P(
    'laredo-colombia',
    'Laredo, Colombia Solidarity',
    'mx',
    'TX',
    27.703,
    -99.7453,
    'medium',
    [{ port: /^laredo/, crossing: /colombia/ }],
  ),
  P('laredo-wtb', 'Laredo, World Trade Bridge', 'mx', 'TX', 27.5994, -99.5362, 'medium', [
    { port: /^laredo/, crossing: /world trade/ },
  ]),
  P('roma', 'Roma', 'mx', 'TX', 26.4041, -99.0186, 'medium', [{ port: /^roma\b/ }]),
  P('rio-grande-city', 'Rio Grande City', 'mx', 'TX', 26.3693, -98.8031, 'medium', [
    { port: /^rio grande/ },
  ]),
  P('pharr', 'Pharr', 'mx', 'TX', 26.0637, -98.1863, 'medium', [
    { port: /^pharr/ },
    { port: /hidalgo|pharr/, crossing: /pharr/ },
  ]),
  P('anzalduas', 'Anzalduas', 'mx', 'TX', 26.1268, -98.3305, 'medium', [
    { port: /^anzalduas/ },
    { port: /hidalgo|pharr/, crossing: /anzalduas/ },
  ]),
  P('hidalgo', 'Hidalgo', 'mx', 'TX', 26.0952, -98.2717, 'high', [
    { port: /^hidalgo/, skip: /pharr|anzalduas|donna/ },
  ]),
  P('progreso', 'Progreso', 'mx', 'TX', 26.0618, -97.9521, 'medium', [
    { port: /^progreso/, skip: /donna/ },
  ]),
  P('los-indios', 'Los Indios', 'mx', 'TX', 26.0396, -97.739, 'medium', [
    { port: /^los indios/ },
    { port: /^brownsville/, crossing: /los indios|free trade/ },
  ]),
  P(
    'brownsville-gateway',
    'Brownsville, Gateway',
    'mx',
    'TX',
    25.8968,
    -97.4967,
    'high',
    [{ port: /^brownsville/, crossing: /gateway/ }],
  ),
  P('brownsville-bm', 'Brownsville, B&M', 'mx', 'TX', 25.8904, -97.5038, 'medium', [
    { port: /^brownsville/, crossing: /\bb and m\b|\bb m\b/ },
  ]),
  P(
    'brownsville-veterans',
    'Brownsville, Veterans',
    'mx',
    'TX',
    25.887,
    -97.4626,
    'medium',
    [{ port: /^brownsville/, crossing: /veterans|los tomates/ }],
  ),

  // --- US-Canada border, west to east ---
  P(
    'point-roberts',
    'Point Roberts',
    'ca',
    'WA',
    49.0016,
    -123.0681,
    'high',
    [{ port: /^point roberts/ }, { port: /^blaine/, crossing: /point roberts/ }],
    /boundary bay/,
  ),
  P(
    'blaine-peace-arch',
    'Blaine, Peace Arch',
    'ca',
    'WA',
    49.0021,
    -122.7564,
    'high',
    [{ port: /^blaine/, crossing: /peace arch/ }],
    /\bdouglas\b|peace arch/,
  ),
  P(
    'blaine-pacific',
    'Blaine, Pacific Highway',
    'ca',
    'WA',
    49.0024,
    -122.7349,
    'high',
    [{ port: /^blaine/, crossing: /pacific/ }],
    /pacific highway/,
  ),
  P(
    'lynden',
    'Lynden',
    'ca',
    'WA',
    49.0016,
    -122.4852,
    'medium',
    [{ port: /^lynden/ }],
    /aldergrove/,
  ),
  P(
    'sumas',
    'Sumas',
    'ca',
    'WA',
    49.0014,
    -122.2647,
    'high',
    [{ port: /^sumas/ }],
    /huntingdon/,
  ),
  P(
    'sweetgrass',
    'Sweetgrass',
    'ca',
    'MT',
    48.9988,
    -111.9596,
    'high',
    [{ port: /^sweet ?grass/ }],
    /coutts/,
  ),
  P(
    'portal',
    'Portal',
    'ca',
    'ND',
    48.9993,
    -102.5508,
    'medium',
    [{ port: /^portal/ }],
    /north portal/,
  ),
  P(
    'pembina',
    'Pembina',
    'ca',
    'ND',
    48.9993,
    -97.2378,
    'medium',
    [{ port: /^pembina/ }],
    /emerson/,
  ),
  P(
    'international-falls',
    'International Falls',
    'ca',
    'MN',
    48.6074,
    -93.4012,
    'medium',
    [{ port: /^international falls/ }],
    /fort frances/,
  ),
  P(
    'sault-ste-marie',
    'Sault Ste. Marie',
    'ca',
    'MI',
    46.5078,
    -84.3607,
    'medium',
    [{ port: /^sault/ }],
    /sault/,
  ),
  P(
    'port-huron',
    'Port Huron, Blue Water Bridge',
    'ca',
    'MI',
    42.9987,
    -82.4237,
    'medium',
    [{ port: /^port huron/ }],
    /blue water|sarnia/,
  ),
  P(
    'detroit-ambassador',
    'Detroit, Ambassador Bridge',
    'ca',
    'MI',
    42.3113,
    -83.0744,
    'high',
    [{ port: /^detroit/, crossing: /ambassador/ }],
    /ambassador/,
  ),
  P(
    'detroit-tunnel',
    'Detroit-Windsor Tunnel',
    'ca',
    'MI',
    42.3287,
    -83.0428,
    'high',
    [{ port: /^detroit/, crossing: /tunnel/ }],
    /tunnel/,
  ),
  P(
    'peace-bridge',
    'Buffalo, Peace Bridge',
    'ca',
    'NY',
    42.9067,
    -78.905,
    'high',
    [{ port: /buffalo|niagara/, crossing: /peace bridge/ }],
    /peace bridge|fort erie/,
  ),
  P(
    'rainbow-bridge',
    'Niagara Falls, Rainbow Bridge',
    'ca',
    'NY',
    43.0898,
    -79.0676,
    'high',
    [{ port: /buffalo|niagara/, crossing: /rainbow/ }],
    /rainbow/,
  ),
  P(
    'whirlpool-bridge',
    'Niagara Falls, Whirlpool Bridge',
    'ca',
    'NY',
    43.1097,
    -79.0583,
    'medium',
    [{ port: /buffalo|niagara/, crossing: /whirlpool/ }],
    /whirlpool/,
  ),
  P(
    'lewiston-bridge',
    'Lewiston-Queenston Bridge',
    'ca',
    'NY',
    43.153,
    -79.0446,
    'high',
    [{ port: /buffalo|niagara|lewiston/, crossing: /lewiston|queenston/ }],
    /queenston|lewiston/,
  ),
  P(
    'ogdensburg',
    'Ogdensburg',
    'ca',
    'NY',
    44.7333,
    -75.4566,
    'medium',
    [{ port: /^ogdensburg/ }],
    /prescott/,
  ),
  P(
    'champlain',
    'Champlain (I-87)',
    'ca',
    'NY',
    45.0085,
    -73.4527,
    'medium',
    [{ port: /^champlain/ }],
    /lacolle.*\b15\b|autoroute 15/,
  ),
  P(
    'highgate-springs',
    'Highgate Springs (I-89)',
    'ca',
    'VT',
    45.0153,
    -73.0855,
    'medium',
    [{ port: /^highgate/ }],
    /philipsburg|armand/,
  ),
  P(
    'derby-line',
    'Derby Line (I-91)',
    'ca',
    'VT',
    45.0057,
    -72.0988,
    'medium',
    [{ port: /^derby line/, skip: /\b143\b|route 5\b|rte 5\b/ }],
    /stanstead.*\b55\b/,
  ),
  P(
    'houlton',
    'Houlton (I-95)',
    'ca',
    'ME',
    46.1429,
    -67.781,
    'medium',
    [{ port: /^houlton/ }],
    /woodstock/,
  ),
]);
