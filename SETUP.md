# Argus setup and testing

How to clone, run, and connect live data feeds. Written for Kali Linux (the
primary research target) but the steps apply to any Linux, and the key list is
OS-independent.

Argus is a CesiumJS globe. Cesium renders with WebGL and **hard-fails on
software rendering**, so the single most important prerequisite is a browser
with working GPU acceleration (see [WebGL / GPU](#webgl--gpu-the-main-gotcha)).

---

## 1. Quick start: demo data, no keys

You can run the whole globe and UI immediately on simulated data, no proxy and
no API keys. Every layer is clearly labelled `DEMO` so mock data is never
mistaken for live.

```bash
git clone https://github.com/H4ch1Net/argus.git
cd argus
npm install
npm run dev
```

Open the printed URL (`http://localhost:5173`). Toggle layers, spin the globe,
try the presets, imagery, and terrain controls.

> The globe/controls overhaul may live on a feature branch until it is merged to
> `main`. To pull a specific branch, clone with:
> `git clone -b <branch-name> https://github.com/H4ch1Net/argus.git`

### Node.js version

Vite 7 needs **Node 20.19+ or 22.12+**. Kali's packaged Node can be older, so
check and, if needed, install a current one with nvm:

```bash
node -v                                   # need >= 20.19 (or >= 22.12)

sudo apt update && sudo apt install -y git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22
```

---

## 2. WebGL / GPU (the main gotcha)

Open Chromium and go to `chrome://gpu`. Read the top block:

- **`WebGL: Hardware accelerated`** -> good, skip the rest of this section.
- **`WebGL: Software only`, or it mentions `SwiftShader` / `llvmpipe`** -> Cesium
  will show a "Hardware acceleration required" screen instead of the globe. Fix
  it below.

**Bare-metal Kali (real GPU):**

```bash
sudo apt install -y mesa-utils
glxinfo | grep "OpenGL renderer"          # should name your GPU, not "llvmpipe"
```

If it says `llvmpipe`, the GPU driver is not loaded (install the vendor driver:
`mesa-vulkan-drivers`, the right `firmware-*` package, or the NVIDIA driver).

**Kali inside a VM (most common):**

- **VMware**: VM Settings -> Display -> enable **Accelerate 3D graphics**, give
  it 1-2 GB video memory, install `open-vm-tools`. Works well.
- **VirtualBox**: WebGL/3D support is poor and usually will **not** satisfy
  Cesium. Prefer VMware or bare metal.
- **QEMU/KVM**: use `virtio-gpu` with virgl
  (`-device virtio-vga-gl -display gtk,gl=on`) and install `mesa-utils` in the
  guest.

**Last resort** (only if `glxinfo` shows a real GPU but Chromium still reports
software): launch with the blocklist off. Do not force software rendering.

```bash
chromium --ignore-gpu-blocklist --enable-gpu-rasterization http://localhost:5173
```

Firefox works too: check `about:support` -> "WebGL 2 Driver Renderer" names your
GPU.

---

## 3. Live data: run the proxy

Real feeds route through the proxy so no secret ever reaches the browser. Use two
terminals.

```bash
# terminal 1 - proxy
cd argus/proxy
npm install
cp ../.env.example ../.env                # then edit ../.env (see keys below)
node server.js                            # http on :8787   (or: npm run start:https)
```

```bash
# terminal 2 - app, pointed at the proxy
cd argus
echo 'VITE_PROXY_BASE_URL=http://localhost:8787' >> .env
npm run dev
```

Keys go in `argus/.env` and are read by the **proxy** (server side). **Never**
put a key in a `VITE_`-prefixed variable: Vite inlines those into the browser
bundle. Restart both processes after editing `.env`.

---

## 4. Data feeds and API keys

All keys below are **free**. Get the three free keys (OpenSky, FIRMS, AISStream)
for a fully live globe at zero cost with no billing setup.

### Works with no key

Turn these on immediately, even without the proxy keys:

| Layer | Source |
|---|---|
| Earthquakes | USGS |
| Satellites | CelesTrak |
| Landmarks + Surveillance / cameras | OpenStreetMap Overpass |
| Search / fly-to | OSM Nominatim |
| OSINT asset lookups + BGP | RIPEstat / RIPE RIS |
| 3D Terrain | Esri World Elevation (keyless) |

### Free key required

| Layer | `.env` variable(s) | How to get it |
|---|---|---|
| **Flights** | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | Register at opensky-network.org, log in -> **Account** -> **API Client**: create a client; it gives a client id + secret (OAuth2). |
| **Fires** | `FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov/api/map_key -> enter your email -> the MAP_KEY is emailed instantly. |
| **Ships (AIS)** | `AISSTREAM_API_KEY` | Sign up at aisstream.io -> **API Keys** -> create one. |

### Optional / conditional

| Layer | Variable | Notes |
|---|---|---|
| **Shodan** | `SHODAN_API_KEY` | Awareness-only (credit-free count queries). A key is free with a student `.edu` email via the GitHub Student Pack; otherwise a paid account. Skip it and the layer stays off. |
| **Photoreal 3D Tiles** | `GOOGLE_MAPS_API_KEY` | Google Maps Platform key. Free monthly tier but requires enabling billing on a Google Cloud project. Optional: without it the "Photoreal" toggle degrades to free 3D terrain. |

### Always simulated

CCTV and Threats have no verified public feed, so they are always synthetic and
stay labelled `DEMO` in the UI.

### Minimal live `.env`

```bash
OPENSKY_CLIENT_ID=your_id
OPENSKY_CLIENT_SECRET=your_secret
FIRMS_MAP_KEY=your_map_key
AISSTREAM_API_KEY=your_key
VITE_PROXY_BASE_URL=http://localhost:8787
```

---

## 5. Serving to a phone over LAN (optional)

Geolocation, device orientation, and service workers only work over HTTPS, so
use the HTTPS dev server and open the port:

```bash
npm run dev:https
sudo ufw allow 5173/tcp                   # only if ufw is active
```

Then browse to `https://<your-kali-ip>:5173` from the phone and accept the
self-signed certificate. Force a shell regardless of device with `?shell=mobile`
or `?shell=desktop`.

---

## 6. Useful commands

```bash
npm run dev            # dev server (mock data unless VITE_PROXY_BASE_URL is set)
npm run dev:https      # dev server over HTTPS (for serving the phone over LAN)
npm run build          # production build to dist/
npm run preview        # serve the production build
npm test               # core pure-logic tests
npm run lint           # eslint
npm run proxy          # run the proxy (http on :8787), from the repo root
```
