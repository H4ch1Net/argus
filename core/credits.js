// Data attribution: every third-party data source Argus can show, with its
// licence or terms in one line and a link, grouped by the layer (or app area)
// that uses it, so the UI can show a credits popover and a layer card can show
// its own credits. The MIT licence covers Argus's code only: each source keeps
// its own terms, and several (CC BY, OGL, ODbL, NLOD) require this attribution.
//
// Adapted from gods-eye-view src/data/dataCredits.js and DATA_SOURCES.md (MIT).
// Pure and Cesium-free. Terms are as recorded by the reference project and the
// Argus feed registry (Oct 2026); they were not re-checked online when written.
//
// Coverage: every proxy feed (proxy/feeds.js and proxy/feeds/*.js) and every
// upstream the scene or proxy reaches directly (core/scene/imagery.js,
// labels.js, terrain.js; proxy/lib/ais.js, tiles.js, risLive.js,
// certStream.js). core/credits.test.js checks this against the live registry, so
// a new feed without a credit fails the tests. A feed matches a credit by id
// (or id pattern), else by its upstream host.

/**
 * @typedef {Object} Credit
 * @property {string} id
 * @property {string} name          who to credit
 * @property {string} terms         licence / terms, one line, plain text
 * @property {string|null} url      licence or source page (https)
 * @property {string[]} layers      layer keys (main.js registrations) or app
 *                                  areas (see GROUP_LABELS) that show this data
 * @property {Array<string|RegExp>} [feeds]  proxy feed ids it covers
 * @property {string[]} [hosts]     upstream hostnames it covers
 * @property {'required'|'courtesy'|'none'} attribution
 * @property {boolean} [nonCommercial]  terms allow non-commercial use only
 * @property {boolean} [keyed]          needs your own key or account
 */

/** Labels for credit groups that are app areas rather than toggleable layers. */
export const GROUP_LABELS = {
  basemap: 'Basemap',
  labels: 'Map labels',
  terrain: 'Terrain',
  search: 'Search and places',
  osint: 'OSINT console',
  cockpit: 'Cockpit briefing',
  terminal: 'Terminal map',
  models: '3D aircraft models',
};

const OSM_LAYERS = [
  'surveillance',
  'landmarks',
  'signals',
  'datacenters',
  'installations',
  'dams',
  'basemap',
  'search',
  'cockpit',
  'directions',
];
const ESRI_TERMS_URL = 'https://www.esri.com/en-us/legal/terms/full-master-agreement';

// The bundled aircraft GLBs (public/models/README.md lists each modification).
const MODEL_CREDITS = [
  ['airplane', 'Boeing 747 by zairiq-123', 'boeing-747-9b16672038ba48f98e6d80a159044ed9'],
  ['jet', 'Private Jet by Nick the Name', 'private-jet-cbdd1de6ced9461e950eafaa302cc82b'],
  [
    'bell206',
    'Bell 206 JetRanger by terran4627',
    'bell-206-jetranger-d2f7ba1d671549d4b26aaf834139a1dd',
  ],
  ['c172', 'Cessna 172 by e737', 'cessna-172-64cddaee5aff470682659a8c08525046'],
  [
    'citation2',
    '1990 Cessna Citation by BlenderCommunityHead',
    '1990-cessna-citation-texture-detailed-exterior-a78839624fe64900a8352cb23462350a',
  ],
  ['mq9', 'MQ-9 by IProZenoN', 'mq-9-fabe963feb354c5584b51f9c470c3f7e'],
  ['b789', 'Boeing 787-9 by Nobilis 2', 'boeing-787-9-b6711e2e698e4e469675c1154a50b7a3'],
  ['atr72', 'ATR 72-600 by Oyan3D', 'atr-72-600-1e1a7186f7444d288675262fcee44744'],
].map(([file, name, slug]) => ({
  id: `model-${file}`,
  name,
  terms: 'CC BY 4.0; optimized for gods-eye-view (see public/models/README.md)',
  url: `https://sketchfab.com/3d-models/${slug}`,
  layers: ['models'],
  feeds: [],
  hosts: ['sketchfab.com'], // where the original works are published
  attribution: 'required',
}));

// The 511-platform state camera networks (core/layers/trafficcams/sources.js,
// proxy/feeds/webcams.js), each with its own developer key. Terms per each
// network's developer page; not re-checked online when written.
const FIVE11_CREDITS = [
  ['ny511', '511NY (New York State DOT)', '511ny.org'],
  ['az511', 'AZ511 (Arizona DOT)', 'az511.gov'],
  ['ga511', '511GA (Georgia DOT)', '511ga.org'],
  ['wi511', '511WI (Wisconsin DOT)', '511wi.gov'],
  ['id511', 'Idaho 511 (Idaho Transportation Department)', '511.idaho.gov'],
  ['udot', 'UDOT Traffic (Utah DOT)', 'udottraffic.utah.gov'],
  ['ak511', 'Alaska 511 (Alaska DOT&PF)', '511.alaska.gov'],
  ['nvroads', 'NVroads (Nevada DOT)', 'www.nvroads.com'],
  ['la511', '511LA (Louisiana DOTD)', 'www.511la.org'],
  ['ctroads', 'CTroads (Connecticut DOT)', 'ctroads.org'],
].map(([id, name, host]) => ({
  id,
  name,
  terms:
    "The network's developer API terms with your own key; camera stills with a courtesy credit to the network",
  url: `https://${host}/`,
  layers: ['trafficcams'],
  feeds: [id, `${id}-img`],
  hosts: [host],
  attribution: 'courtesy',
  keyed: true,
}));

/** @type {Credit[]} */
export const CREDITS = [
  ...MODEL_CREDITS,
  // --- air and space ----------------------------------------------------------
  {
    id: 'opensky',
    name: 'OpenSky Network',
    terms:
      'Non-commercial research and education use; cite Schäfer et al., "Bringing Up OpenSky", IPSN 2014',
    url: 'https://opensky-network.org',
    layers: ['flights'],
    feeds: ['opensky'],
    hosts: ['opensky-network.org', 'auth.opensky-network.org'],
    attribution: 'required',
    nonCommercial: true,
    keyed: true,
  },
  {
    id: 'adsblol',
    name: 'adsb.lol',
    terms:
      'ODbL 1.0 (adsb.lol contributors); the aircraft trace files are an undocumented path',
    url: 'https://adsb.lol',
    layers: ['flights', 'military'],
    feeds: ['adsblol', 'adsblol-trace'],
    hosts: ['api.adsb.lol', 'adsb.lol'],
    attribution: 'required',
  },
  {
    id: 'adsbdb',
    name: 'adsbdb',
    terms:
      'No licence published. Aircraft data from PlaneBase; route data is the work of David Taylor, Edinburgh, and Jim Mason, Glasgow, and may not be copied, published or incorporated into other databases without the explicit permission of David J Taylor, Edinburgh',
    url: 'https://www.adsbdb.com',
    layers: ['flights', 'military'],
    feeds: ['adsbdb'],
    hosts: ['api.adsbdb.com'],
    attribution: 'required',
  },
  {
    id: 'own-receivers',
    name: 'Your own receivers',
    terms:
      'Decoded by equipment you run (ADS-B 1090 MHz, UAT 978 MHz); no third-party terms',
    url: null,
    layers: ['localadsb'],
    feeds: [/^local-/],
    attribution: 'none',
  },
  {
    id: 'celestrak',
    name: 'CelesTrak',
    terms:
      'US-government-origin orbital elements, no licence; citation requested: "CelesTrak (celestrak.org), Dr. T.S. Kelso"',
    url: 'https://celestrak.org',
    layers: ['satellites', 'constellations', 'starlink'],
    feeds: ['celestrak'],
    hosts: ['celestrak.org'],
    attribution: 'courtesy',
  },
  {
    id: 'll2',
    name: 'Launch Library 2 (The Space Devs)',
    terms: 'Free to use and share, attribution encouraged; 15 keyless calls an hour',
    url: 'https://thespacedevs.com',
    layers: ['launches'],
    feeds: ['ll2'],
    hosts: ['ll.thespacedevs.com'],
    attribution: 'courtesy',
  },

  // --- ground and sea ---------------------------------------------------------
  {
    id: 'aisstream',
    name: 'AISStream.io',
    terms:
      'Free beta service with your own key, no formal terms published; AIS is a public broadcast',
    url: 'https://aisstream.io',
    layers: ['ships'],
    hosts: ['stream.aisstream.io'],
    attribution: 'courtesy',
    keyed: true,
  },
  {
    id: 'gbfs',
    name: 'GBFS bikeshare operators',
    terms:
      "Each system's GBFS licence, attribution to its operator (Citi Bike, Divvy, Capital Bikeshare and Bay Wheels by Lyft; Bluebikes; Biketown; CoGo; MetroBike; Biki; BCycle systems)",
    url: 'https://github.com/MobilityData/gbfs',
    layers: ['bikeshare'],
    feeds: [/^gbfs-/],
    attribution: 'required',
  },
  {
    id: 'mbta',
    name: 'MBTA / MassDOT',
    terms: 'MassDOT developers licence agreement; attribution to the MBTA',
    url: 'https://www.mbta.com/developers',
    layers: ['transit'],
    feeds: ['gtfsrt-mbta'],
    hosts: ['cdn.mbta.com'],
    attribution: 'courtesy',
  },
  {
    id: 'capmetro',
    name: 'CapMetro (Austin)',
    terms:
      'Open realtime vehicle data on the Texas Open Data Portal; courtesy attribution',
    url: 'https://data.texas.gov',
    layers: ['transit'],
    feeds: ['gtfsrt-capmetro'],
    hosts: ['data.texas.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'metrotransit',
    name: 'Metro Transit (Metropolitan Council)',
    terms: 'Open realtime vehicle data published for developers; courtesy attribution',
    url: 'https://svc.metrotransit.org',
    layers: ['transit'],
    feeds: ['gtfsrt-metrotransit'],
    hosts: ['svc.metrotransit.org'],
    attribution: 'courtesy',
  },
  {
    id: 'hsl',
    name: 'HSL (Helsinki Region Transport)',
    terms: 'HSL open data, CC BY 4.0; attribution to HSL',
    url: 'https://www.hsl.fi/en/hsl/open-data',
    layers: ['transit'],
    feeds: ['gtfsrt-hsl'],
    hosts: ['realtime.hsl.fi'],
    attribution: 'required',
  },
  {
    id: 'ovapi',
    name: 'OVapi / Stichting OpenGeo',
    terms: 'Open realtime vehicle data published for developers; courtesy attribution',
    url: 'https://gtfs.ovapi.nl',
    layers: ['transit'],
    feeds: ['gtfsrt-ovapi'],
    hosts: ['gtfs.ovapi.nl'],
    attribution: 'courtesy',
  },
  {
    id: 'entur',
    name: 'Entur',
    terms: 'Open data under NLOD 2.0; attribution to Entur',
    url: 'https://developer.entur.org',
    layers: ['transit'],
    feeds: ['gtfsrt-entur'],
    hosts: ['api.entur.io'],
    attribution: 'required',
  },
  {
    id: 'translink',
    name: 'TransLink (Queensland Government)',
    terms: 'Queensland Government open data, CC BY 4.0; attribution to TransLink',
    url: 'https://www.data.qld.gov.au',
    layers: ['transit'],
    feeds: ['gtfsrt-translink'],
    hosts: ['gtfsrt.api.translink.com.au'],
    attribution: 'required',
  },
  {
    id: 'tomtom',
    name: 'TomTom Traffic',
    terms:
      'TomTom for Developers terms with your own key (free tier about 200,000 tiles a month, and about 2,500 non-tile requests a day for incidents); attribution required: "Traffic flow data © TomTom", and "© TomTom" beside incidents',
    url: 'https://docs.tomtom.com/legal/terms-and-conditions',
    layers: ['trafficflow', 'incidents'],
    feeds: ['tomtom-flow', 'tomtom-incidents'],
    hosts: ['api.tomtom.com'],
    attribution: 'required',
    keyed: true,
  },
  {
    id: 'chp',
    name: 'California Highway Patrol',
    terms:
      'Public CHP CAD incident list (type, place, time); California public information with a courtesy credit "California Highway Patrol". Dispatch notes are never read',
    url: 'https://cad.chp.ca.gov/',
    layers: ['chp'],
    feeds: ['chp-cad'],
    hosts: ['media.chp.ca.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'osrm',
    name: 'OSRM on the FOSSGIS servers',
    terms:
      'FOSSGIS routing usage policy: show this credit and a "fix the map" link (openstreetmap.org/fixthemap), a valid User-Agent, at most 1 request a second, no heavy use; data ODbL 1.0 from OpenStreetMap',
    url: 'https://routing.openstreetmap.de/about.html',
    layers: ['directions'],
    feeds: ['osrm'],
    hosts: ['routing.openstreetmap.de'],
    attribution: 'required',
  },

  // --- earth and weather ------------------------------------------------------
  {
    id: 'usgs',
    name: 'U.S. Geological Survey',
    terms: 'Public domain: "Data courtesy of the U.S. Geological Survey"',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/',
    layers: ['quakes'],
    feeds: ['usgs-quakes'],
    hosts: ['earthquake.usgs.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'firms',
    name: 'NASA FIRMS',
    terms:
      'NASA open data with your own MAP_KEY; acknowledgement: "We acknowledge the use of data and/or imagery from NASA\'s Fire Information for Resource Management System (FIRMS), part of NASA\'s Earth Observing System Data and Information System (EOSDIS)"',
    url: 'https://firms.modaps.eosdis.nasa.gov',
    layers: ['fires'],
    feeds: ['firms'],
    hosts: ['firms.modaps.eosdis.nasa.gov'],
    attribution: 'required',
    keyed: true,
  },
  {
    id: 'wfigs',
    name: 'NIFC WFIGS (Wildland Fire Interagency Geospatial Services)',
    terms: 'US public domain, published through the NIFC Open Data portal',
    url: 'https://data-nifc.opendata.arcgis.com',
    layers: ['perimeters'],
    feeds: ['wfigs'],
    hosts: ['services3.arcgis.com'],
    attribution: 'courtesy',
  },
  {
    id: 'inciweb',
    name: 'InciWeb',
    terms: 'US government incident information; linked pages remain InciWeb content',
    url: 'https://inciweb.wildfire.gov',
    layers: ['perimeters'],
    feeds: ['inciweb'],
    hosts: ['inciweb.wildfire.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'nhc',
    name: 'NOAA National Hurricane Center (NHC / CPHC)',
    terms: 'Public domain under the NWS disclaimer; no endorsement implied',
    url: 'https://www.nhc.noaa.gov',
    layers: ['cyclones', 'cyclonecones'],
    feeds: ['nhc'],
    hosts: ['www.nhc.noaa.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'nhc-gis',
    name: 'NOAA NHC tropical GIS (forecast tracks and cones)',
    terms:
      'Public domain under the NWS disclaimer; the cone is the uncertainty of the centre track, not the storm size',
    url: 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer',
    layers: ['cyclones', 'cyclonecones'],
    feeds: ['nhc-gis'],
    hosts: ['mapservices.weather.noaa.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'nowcoast',
    name: 'NOAA nowCOAST',
    terms:
      'Public domain under the NOAA disclaimer: NWS/OAR MRMS radar, NESDIS GOES and partner satellites; lightning density is a NOAA product derived from Vaisala NLDN/GLD360, not raw detections',
    url: 'https://nowcoast.noaa.gov',
    layers: ['clouds', 'radar', 'lightning'],
    feeds: ['nowcoast'],
    hosts: ['nowcoast.noaa.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'nasa-gibs',
    name: 'NASA GIBS and Worldview Snapshots',
    terms:
      'NASA open data, no restrictions; acknowledgement: "We acknowledge the use of imagery provided by services from NASA\'s Global Imagery Browse Services (GIBS), part of NASA\'s Earth Science Data and Information System (ESDIS)"',
    url: 'https://gibs.earthdata.nasa.gov',
    // Also the Blue Marble and Black Marble basemaps (VIEW > BASEMAP).
    layers: ['imagery', 'basemap', 'terminator'],
    // gibs-night: the Black Marble night lights over the terminator's night side.
    feeds: ['gibs', 'wvs', 'gibs-night'],
    hosts: [
      'gibs.earthdata.nasa.gov',
      'gibs-a.earthdata.nasa.gov',
      'gibs-b.earthdata.nasa.gov',
      'gibs-c.earthdata.nasa.gov',
      'wvs.earthdata.nasa.gov',
    ],
    attribution: 'required',
  },
  {
    id: 'nasa-hls',
    name: 'NASA CMR and HLS (LP DAAC)',
    terms:
      'NASA open data: Harmonized Landsat Sentinel-2 (HLS S30/L30 v2.0) from the Land Processes DAAC; S30 contains modified Copernicus Sentinel data',
    url: 'https://lpdaac.usgs.gov/products/hlss30v002/',
    layers: ['imagery'],
    feeds: ['cmr'],
    hosts: ['cmr.earthdata.nasa.gov'],
    attribution: 'required',
  },

  {
    id: 'eox-s2cloudless',
    name: 'Sentinel-2 cloudless by EOX IT Services GmbH',
    terms:
      'Sentinel-2 cloudless (s2maps.eu): the 2016 edition CC BY 4.0, later editions CC BY-NC-SA 4.0 (non-commercial); credit "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)"',
    url: 'https://s2maps.eu',
    layers: ['basemap'],
    hosts: ['tiles.maps.eox.at'],
    attribution: 'required',
    nonCommercial: true,
  },
  {
    id: 'opentopomap',
    name: 'OpenTopoMap',
    terms:
      'CC BY-SA 3.0 map style; data © OpenStreetMap contributors (ODbL) and SRTM; light personal use under its tile policy',
    url: 'https://opentopomap.org/about',
    layers: ['basemap'],
    hosts: ['tile.opentopomap.org'],
    attribution: 'required',
  },

  // --- infrastructure ---------------------------------------------------------
  {
    id: 'openstreetmap',
    name: 'OpenStreetMap contributors',
    terms:
      'ODbL 1.0: "© OpenStreetMap contributors"; standard map tiles under the OSMF tile usage policy',
    url: 'https://www.openstreetmap.org/copyright',
    layers: OSM_LAYERS,
    feeds: ['overpass', 'nominatim'],
    hosts: ['tile.openstreetmap.org'],
    attribution: 'required',
  },
  {
    id: 'overpass',
    name: 'Overpass API',
    terms:
      'Public instance under its usage policy (fair use, about 10,000 queries and 1 GB a day); data ODbL 1.0 from OpenStreetMap',
    url: 'https://overpass-api.de',
    layers: [
      'surveillance',
      'landmarks',
      'signals',
      'datacenters',
      'installations',
      'dams',
    ],
    feeds: ['overpass'],
    hosts: ['overpass-api.de'],
    attribution: 'courtesy',
  },
  {
    // DeFlock maps ALPR readers into OpenStreetMap (surveillance:type=ALPR with
    // manufacturer / operator tags); the surveillance layer reads them from OSM
    // through Overpass and never contacts deflock.me itself.
    id: 'deflock',
    name: 'DeFlock (ALPR mapping in OpenStreetMap)',
    terms:
      'Crowd-sourced ALPR locations contributed to OpenStreetMap; the data is ODbL 1.0 as part of OSM',
    url: 'https://deflock.me',
    layers: ['surveillance'],
    hosts: ['deflock.me'],
    attribution: 'courtesy',
  },
  {
    id: 'telegeography',
    name: 'TeleGeography Submarine Cable Map',
    terms: 'CC BY-NC-SA 3.0, non-commercial: "TeleGeography, submarinecablemap.com"',
    url: 'https://www.submarinecablemap.com',
    layers: ['cables'],
    feeds: ['cables'],
    hosts: ['www.submarinecablemap.com'],
    attribution: 'required',
    nonCommercial: true,
  },
  {
    id: 'caltrans',
    name: 'Caltrans',
    terms: 'Public highway camera data, courtesy credit: "Caltrans, cwwp2.dot.ca.gov"',
    url: 'https://cwwp2.dot.ca.gov',
    layers: ['trafficcams'],
    feeds: ['caltrans', 'caltrans-img'],
    hosts: ['cwwp2.dot.ca.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'tfl',
    name: 'Transport for London (JamCams)',
    terms:
      'TfL Open Data terms, attribution required: "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights"',
    url: 'https://tfl.gov.uk/info-for/open-data-users/',
    layers: ['trafficcams'],
    feeds: ['tfl', 'tfl-img'],
    hosts: ['api.tfl.gov.uk'],
    attribution: 'required',
  },
  {
    id: 'vegvesen',
    name: 'Statens vegvesen',
    terms:
      'NLOD 2.0, attribution required: "Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Statens vegvesen"',
    url: 'https://data.norge.no/nlod/en/2.0',
    layers: ['trafficcams'],
    feeds: ['vegvesen', 'vegvesen-img'],
    hosts: ['ogckart-sn1.atlas.vegvesen.no', 'kamera.atlas.vegvesen.no'],
    attribution: 'required',
  },
  {
    id: 'ontario511',
    name: 'Ontario 511',
    terms: 'Open Government Licence - Ontario, attribution required: "Ontario 511"',
    url: 'https://www.ontario.ca/page/open-government-licence-ontario',
    layers: ['trafficcams'],
    feeds: ['on511', 'on511-img'],
    hosts: ['511on.ca'],
    attribution: 'required',
  },
  {
    id: 'drivebc',
    name: 'DriveBC (Government of British Columbia)',
    terms:
      'Open Government Licence - British Columbia: "Contains information licensed under the Open Government Licence - British Columbia"; partner cameras are named on each card',
    url: 'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc',
    layers: ['trafficcams'],
    feeds: ['drivebc', 'drivebc-img'],
    hosts: ['www.drivebc.ca', 'images.drivebc.ca'],
    attribution: 'required',
  },
  {
    id: 'calgary',
    name: 'City of Calgary (Open Calgary)',
    terms:
      'Open Government Licence - City of Calgary: "Contains information licensed under the Open Government Licence - City of Calgary"',
    url: 'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa',
    layers: ['trafficcams'],
    feeds: ['calgary', 'calgary-img'],
    hosts: ['data.calgary.ca', 'trafficcam.calgary.ca'],
    attribution: 'required',
  },
  {
    id: 'fintraffic',
    name: 'Fintraffic / Digitraffic',
    terms:
      'CC BY 4.0, attribution required: "Fintraffic / digitraffic.fi, license CC BY 4.0"',
    url: 'https://www.digitraffic.fi/en/terms-of-service/',
    layers: ['trafficcams'],
    feeds: ['fintraffic', 'fintraffic-img'],
    hosts: ['tie.digitraffic.fi', 'weathercam.digitraffic.fi'],
    attribution: 'required',
  },
  {
    id: 'txdot',
    name: 'Texas Department of Transportation (TxDOT)',
    terms: 'Public traffic camera data, courtesy credit',
    url: 'https://its.txdot.gov',
    layers: ['trafficcams'],
    feeds: ['txdot', 'txdot-img'],
    hosts: ['its.txdot.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'austin',
    name: 'City of Austin, TX',
    terms:
      'City of Austin Open Data terms of use: "City of Austin, TX, data.austintexas.gov"',
    url: 'https://data.austintexas.gov',
    layers: ['trafficcams'],
    feeds: ['austin', 'austin-img'],
    hosts: ['data.austintexas.gov', 'cctv.austinmobility.io'],
    attribution: 'required',
  },
  {
    id: 'tarktee',
    name: 'Transpordiamet / Tarktee (Estonia)',
    terms: 'Public road camera data, courtesy credit',
    url: 'https://tarktee.transpordiamet.ee',
    layers: ['trafficcams'],
    feeds: ['tarktee', 'tarktee-img'],
    hosts: ['tarktee.transpordiamet.ee'],
    attribution: 'courtesy',
  },
  {
    id: 'tallinn',
    name: 'City of Tallinn',
    terms:
      'Public traffic camera data, courtesy credit: "City of Tallinn, ristmikud.tallinn.ee"',
    url: 'https://ristmikud.tallinn.ee',
    layers: ['trafficcams'],
    feeds: ['tallinn', 'tallinn-img'],
    hosts: ['ristmikud.tallinn.ee'],
    attribution: 'courtesy',
  },
  {
    id: 'warendorf',
    name: 'Stadt Warendorf',
    terms:
      'Public municipal webcam, courtesy credit; the camera pose is derived from OpenStreetMap (ODbL)',
    url: 'https://www.warendorf.de',
    layers: ['trafficcams'],
    feeds: ['warendorf', 'warendorf-img'],
    hosts: ['webcam.warendorf.de'],
    attribution: 'courtesy',
  },
  {
    id: 'nycdot',
    name: 'NYC DOT (webcams.nyctmc.org)',
    terms: 'Public traffic camera stills, courtesy credit: "NYC DOT"',
    url: 'https://webcams.nyctmc.org',
    layers: ['trafficcams'],
    feeds: ['nycdot', 'nycdot-img'],
    hosts: ['webcams.nyctmc.org'],
    attribution: 'courtesy',
  },
  {
    id: 'lta-sg',
    name: 'Land Transport Authority, Singapore (data.gov.sg)',
    terms:
      'Singapore Open Data Licence v1.0, attribution required: "Contains information from Traffic Images accessed from data.gov.sg, made available under the Singapore Open Data Licence version 1.0"',
    url: 'https://data.gov.sg/open-data-licence',
    layers: ['trafficcams'],
    feeds: ['lta-sg', 'lta-sg-img'],
    hosts: ['api.data.gov.sg', 'images.data.gov.sg'],
    attribution: 'required',
  },
  {
    id: 'wsdot',
    name: 'Washington State DOT (WSDOT)',
    terms:
      'WSDOT Traveler Information API with your own access code; courtesy credit "WSDOT"; partner cameras are named on each card',
    url: 'https://wsdot.wa.gov/traffic/api/',
    layers: ['trafficcams'],
    feeds: ['wsdot', 'wsdot-img'],
    hosts: ['www.wsdot.wa.gov', 'images.wsdot.wa.gov'],
    attribution: 'courtesy',
    keyed: true,
  },
  ...FIVE11_CREDITS,

  // --- public webcams -----------------------------------------------------------
  {
    id: 'windy-webcams',
    name: 'Windy.com Webcams',
    terms:
      'Windy Webcams API terms with your own key (free tier: preview-size stills whose links expire after about 10 minutes); attribution with a link back to windy.com required: "Webcams provided by windy.com"',
    url: 'https://api.windy.com/webcams/docs',
    layers: ['webcams'],
    feeds: ['windy', 'windy-img', 'windy-imgproxy'],
    hosts: ['api.windy.com', 'images-webcams.windy.com', 'imgproxy.windy.com'],
    attribution: 'required',
    keyed: true,
  },
  {
    id: 'nps',
    name: 'U.S. National Park Service',
    terms:
      'NPS Data API with your own free key; US federal data, generally public domain; webcam images may carry their own credit, shown on each card',
    url: 'https://www.nps.gov/subjects/developer/index.htm',
    layers: ['webcams'],
    feeds: ['nps-webcams', 'nps-img'],
    hosts: ['developer.nps.gov', 'www.nps.gov'],
    attribution: 'courtesy',
    keyed: true,
  },
  {
    id: 'nasa-epic',
    name: 'NASA EPIC (DSCOVR)',
    terms: 'NASA imagery, public domain; credit "NASA EPIC Team"',
    url: 'https://epic.gsfc.nasa.gov/about',
    layers: ['webcams'],
    feeds: ['epic', 'epic-img'],
    hosts: ['epic.gsfc.nasa.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'nasa-sdo',
    name: 'NASA Solar Dynamics Observatory',
    terms:
      'NASA imagery, public domain; credit "Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams"',
    url: 'https://sdo.gsfc.nasa.gov/data/',
    layers: ['webcams'],
    feeds: ['sdo-img'],
    hosts: ['sdo.gsfc.nasa.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'soho',
    name: 'SOHO (ESA & NASA)',
    terms: 'Free use with credit: "SOHO (ESA & NASA)"',
    url: 'https://soho.nascom.nasa.gov/data/realtime-images.html',
    layers: ['webcams'],
    feeds: ['soho-img'],
    hosts: ['soho.nascom.nasa.gov'],
    attribution: 'required',
  },

  // --- border crossings -----------------------------------------------------------
  {
    id: 'cbp-bwt',
    name: 'U.S. Customs and Border Protection (Border Wait Times)',
    terms:
      'US federal data, public domain; courtesy credit "U.S. Customs and Border Protection"',
    url: 'https://bwt.cbp.gov',
    layers: ['borderwaits'],
    feeds: ['cbp-bwt'],
    hosts: ['bwt.cbp.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'cbsa-bwt',
    name: 'Canada Border Services Agency (Border Wait Times)',
    terms:
      'Open Government Licence - Canada: "Contains information licensed under the Open Government Licence - Canada"',
    url: 'https://open.canada.ca/en/open-government-licence-canada',
    layers: ['borderwaits'],
    feeds: ['cbsa-bwt'],
    hosts: ['www.cbsa-asfc.gc.ca'],
    attribution: 'required',
  },

  // --- signals ----------------------------------------------------------------
  {
    id: 'radiobrowser',
    name: 'Radio Browser',
    terms:
      "Directory data public domain (PDDL 1.0); each broadcaster's stream keeps its own terms",
    url: 'https://www.radio-browser.info',
    layers: ['radio'],
    feeds: ['radiobrowser'],
    hosts: ['all.api.radio-browser.info'],
    attribution: 'courtesy',
  },
  {
    id: 'shodan',
    name: 'Shodan',
    terms: 'Shodan API terms with your own membership; used here for awareness only',
    url: 'https://www.shodan.io',
    layers: ['shodan', 'osint'],
    feeds: ['shodan'],
    hosts: ['api.shodan.io'],
    attribution: 'courtesy',
    keyed: true,
  },
  {
    id: 'ris-live',
    name: 'RIPE RIS Live (RIPE NCC)',
    terms:
      'Public BGP data from the RIPE NCC Routing Information Service; RIPE NCC terms of use',
    url: 'https://ris-live.ripe.net',
    layers: ['bgp'],
    hosts: ['ris-live.ripe.net'],
    attribution: 'courtesy',
  },
  {
    id: 'ripestat',
    name: 'RIPEstat (RIPE NCC)',
    terms:
      'RIPEstat Data API terms of use; geolocation answers include GeoLite2 data created by MaxMind',
    url: 'https://stat.ripe.net',
    layers: ['osint'],
    feeds: ['ripestat'],
    hosts: ['stat.ripe.net'],
    attribution: 'required',
  },
  {
    id: 'certstream',
    name: 'CertStream (Calidog) and Certificate Transparency logs',
    terms:
      'Public CT log entries relayed by the CertStream service (CT_STREAM_URL may name another)',
    url: 'https://certstream.calidog.io',
    layers: ['osint'],
    hosts: ['certstream.calidog.io'],
    attribution: 'courtesy',
  },

  // --- context layers: aurora, air quality, Tor ------------------------------
  {
    id: 'swpc',
    name: 'NOAA Space Weather Prediction Center',
    terms:
      'Public domain under the NOAA disclaimer: the OVATION aurora nowcast and the planetary K index',
    url: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
    layers: ['aurora'],
    feeds: ['swpc'],
    hosts: ['services.swpc.noaa.gov'],
    attribution: 'courtesy',
  },
  {
    id: 'open-meteo-aq',
    name: 'Open-Meteo Air Quality (Copernicus CAMS)',
    terms:
      'CC BY 4.0 with a linked "Open-Meteo.com" credit and "Contains modified Copernicus Atmosphere Monitoring Service information"; the free API is for non-commercial use',
    url: 'https://open-meteo.com/en/docs/air-quality-api',
    layers: ['airquality'],
    feeds: ['openmeteo-aq'],
    hosts: ['air-quality-api.open-meteo.com'],
    attribution: 'required',
    nonCommercial: true,
  },
  {
    id: 'tor-metrics',
    name: 'The Tor Project (Tor Metrics, Onionoo)',
    terms:
      'Tor Metrics data under CC BY 3.0 US: "The Tor Project"; public relay descriptors (the operator contact field is never requested)',
    url: 'https://metrics.torproject.org/onionoo.html',
    layers: ['tor'],
    feeds: ['onionoo'],
    hosts: ['onionoo.torproject.org'],
    attribution: 'required',
  },

  // --- cockpit briefing -------------------------------------------------------
  {
    id: 'open-meteo',
    name: 'Open-Meteo',
    terms:
      'CC BY 4.0 data with a linked "Weather data by Open-Meteo.com" credit beside it; the free API is for non-commercial use (about 10,000 calls a day)',
    url: 'https://open-meteo.com/en/licence',
    layers: ['cockpit', 'wind'],
    feeds: ['openmeteo', 'openmeteo-wind'],
    hosts: ['api.open-meteo.com'],
    attribution: 'required',
    nonCommercial: true,
  },
  {
    id: 'gdelt',
    name: 'GDELT Project',
    terms:
      "Free for any use with a citation and a link to the GDELT Project; linked articles keep their publishers' terms",
    url: 'https://www.gdeltproject.org/about.html#termsofuse',
    layers: ['cockpit', 'gdelt'],
    feeds: ['gdelt', 'gdelt-geo'],
    hosts: ['api.gdeltproject.org'],
    attribution: 'required',
  },
  {
    id: 'google-news',
    name: 'Google News RSS',
    terms:
      "Google News terms: personal, non-commercial use only; linked articles keep their publishers' terms",
    url: 'https://www.google.com/intl/en_us/terms_google_news.html',
    layers: ['cockpit'],
    feeds: ['gnews'],
    hosts: ['news.google.com'],
    attribution: 'required',
    nonCommercial: true,
  },

  // --- basemap, labels, terrain, search --------------------------------------
  {
    id: 'natural-earth',
    name: 'Natural Earth',
    terms:
      'Public domain: the offline relief basemap (Natural Earth II, shipped with Cesium) and the terminal coastlines (via the world-atlas package)',
    url: 'https://www.naturalearthdata.com',
    layers: ['basemap', 'terminal'],
    feeds: ['basemap'],
    attribution: 'courtesy',
  },
  {
    id: 'esri-imagery',
    name: 'Esri World Imagery',
    terms:
      'Esri terms of use, attribution required: "Powered by Esri. Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community"',
    url: ESRI_TERMS_URL,
    layers: ['basemap'],
    hosts: ['server.arcgisonline.com'],
    attribution: 'required',
  },
  {
    id: 'esri-basemaps',
    name: 'Esri basemaps and reference labels',
    terms:
      'World Dark Gray Canvas (base and reference), World Boundaries and Places, World Transportation: Esri terms of use, attribution required ("Powered by Esri" and each service\'s own source credits, shown with its tiles)',
    url: ESRI_TERMS_URL,
    layers: ['basemap', 'labels'],
    hosts: ['services.arcgisonline.com'],
    attribution: 'required',
  },
  {
    id: 'esri-elevation',
    name: 'Esri World Elevation',
    terms: 'Esri terms of use; keyless Terrain3D elevation service, attribution required',
    url: ESRI_TERMS_URL,
    layers: ['terrain'],
    hosts: ['elevation3d.arcgis.com'],
    attribution: 'required',
  },
  {
    id: 'google-3d-tiles',
    name: 'Google Photorealistic 3D Tiles',
    terms:
      'Google Maps Platform terms with your own key; the Google logo and data credits stay on screen; the content may not be cached, stored or rehosted',
    url: 'https://cloud.google.com/maps-platform/terms',
    layers: ['terrain'],
    hosts: ['tile.googleapis.com'],
    attribution: 'required',
    keyed: true,
  },
  {
    id: 'nominatim',
    name: 'Nominatim (OpenStreetMap Foundation)',
    terms:
      'Nominatim usage policy: at most 1 request a second, an identifying User-Agent, no bulk geocoding; data ODbL 1.0 from OpenStreetMap',
    url: 'https://operations.osmfoundation.org/policies/nominatim/',
    layers: ['search', 'cockpit'],
    feeds: ['nominatim'],
    hosts: ['nominatim.openstreetmap.org'],
    attribution: 'required',
  },
  {
    id: 'photon',
    name: 'Photon (Komoot)',
    terms:
      'Free public instance under fair use (no bulk or heavy use); data ODbL 1.0 from OpenStreetMap',
    url: 'https://photon.komoot.io',
    layers: ['search'],
    feeds: ['photon'],
    hosts: ['photon.komoot.io'],
    attribution: 'courtesy',
  },
];

const BY_ID = new Map(CREDITS.map((c) => [c.id, c]));

/** One credit by id, or null. */
export const creditById = (id) => BY_ID.get(id) ?? null;

/** The credits a layer (or app area) shows, in registry order. */
export function creditsForLayer(layerKey) {
  return CREDITS.filter((c) => c.layers.includes(layerKey));
}

/**
 * Credits grouped by layer key, for a popover: [{ layer, label, credits }].
 * With `layerKeys` (e.g. the layers registered or switched on), only those
 * groups, in that order; otherwise every group in first-appearance order.
 * Groups with no credits (demo layers) are left out.
 */
export function creditsByLayer(layerKeys = null) {
  const keys = layerKeys ?? [...new Set(CREDITS.flatMap((c) => c.layers))];
  return keys
    .map((layer) => ({
      layer,
      label: GROUP_LABELS[layer] ?? null,
      credits: creditsForLayer(layer),
    }))
    .filter((g) => g.credits.length);
}

/** Credits naming this upstream hostname. */
export function creditsForHost(hostname) {
  const h = String(hostname ?? '').toLowerCase();
  return h ? CREDITS.filter((c) => (c.hosts ?? []).includes(h)) : [];
}

const idMatches = (pattern, id) =>
  pattern instanceof RegExp ? pattern.test(id) : pattern === id;

/**
 * The credits covering a proxy feed (a Feed object or just its id): by id or
 * id pattern first, else by the feed's upstream host, else (a localOnly feed)
 * your own equipment.
 * @param {string | { id: string, baseUrl?: string, localOnly?: boolean }} feed
 */
export function creditsForFeed(feed) {
  const id = typeof feed === 'string' ? feed : feed?.id;
  if (!id) return [];
  const byId = CREDITS.filter((c) => (c.feeds ?? []).some((p) => idMatches(p, id)));
  if (byId.length) return byId;
  if (typeof feed === 'object' && feed.baseUrl && URL.canParse(feed.baseUrl)) {
    const byHost = creditsForHost(new URL(feed.baseUrl).hostname);
    if (byHost.length) return byHost;
  }
  if (typeof feed === 'object' && feed.localOnly) return [BY_ID.get('own-receivers')];
  return [];
}

/** A credit as one plain-text line: "Name: terms". */
export function creditText(credit) {
  return credit ? `${credit.name}: ${credit.terms}` : '';
}
