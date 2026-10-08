package net.h4ch1.argus.car

import android.Manifest
import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Rect
import android.graphics.drawable.ColorDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.car.app.AppManager
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import net.h4ch1.argus.Ink
import net.h4ch1.argus.NodeRuntime
import net.h4ch1.argus.Prefs
import org.json.JSONArray
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Draws the globe on the car display. Android Auto hands a navigation app a
 * Surface; a private VirtualDisplay renders onto it, and a Presentation on
 * that display hosts a WebView on the car shell
 * (http://127.0.0.1:<port>/?shell=car), served by the proxy on the phone.
 * Touch reaches the app as SurfaceCallback gestures, which are forwarded to
 * the page's window.argusCar (shell-car/index.js) in CSS pixels; the phone's
 * location is pushed the same way.
 */
class CarMapRenderer(
    private val carContext: CarContext,
    lifecycle: Lifecycle,
) : SurfaceCallback, DefaultLifecycleObserver {
    private val main = Handler(Looper.getMainLooper())
    private val location = CarLocationFeed(carContext) { onFix(it) }
    private var virtualDisplay: VirtualDisplay? = null
    private var presentation: Presentation? = null
    private var webView: WebView? = null
    private var surfaceWidth = 0
    private var surfaceHeight = 0
    private var density = 1f
    private var visibleArea: Rect? = null
    private var loadedPort = 0
    private var pageReady = false
    private var lastFix: String? = null
    private var unobserve: (() -> Unit)? = null

    init {
        lifecycle.addObserver(this)
    }

    override fun onCreate(owner: LifecycleOwner) {
        NodeRuntime.start(carContext)
        carContext.getCarService(AppManager::class.java).setSurfaceCallback(this)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        location.stop()
        unobserve?.invoke()
        unobserve = null
        release()
    }

    // ------------------------------------------------------------ controls

    fun recenter() = js("recenter()")

    fun zoom(factor: Float) = js("zoom(${num(factor)})")

    fun pushLayers() = js("setLayers(${JSONArray(Prefs(carContext).carLayers.sorted())})")

    fun onLocationPermission() {
        if (virtualDisplay != null) location.start()
    }

    // ------------------------------------------------------------- surface

    override fun onSurfaceAvailable(container: SurfaceContainer) {
        val surface = container.surface ?: return
        surfaceWidth = container.width
        surfaceHeight = container.height
        // Car displays sit at arm's length: lay the page out a little larger
        // than the display's own density.
        val dpi = (max(container.dpi, 160) * UI_SCALE).roundToInt()
        density = dpi / 160f
        val existing = virtualDisplay
        if (existing != null) {
            existing.resize(surfaceWidth, surfaceHeight, dpi)
            existing.surface = surface
            pushInsets()
            return
        }
        val displays = carContext.getSystemService(DisplayManager::class.java) ?: return
        val created = displays.createVirtualDisplay(
            DISPLAY_NAME,
            surfaceWidth,
            surfaceHeight,
            dpi,
            surface,
            0, // private: only this app's windows, never mirrored
        ) ?: return
        virtualDisplay = created
        showPresentation(created.display)
        if (unobserve == null) unobserve = NodeRuntime.observe { onRuntime(it) }
        location.start()
    }

    override fun onSurfaceDestroyed(container: SurfaceContainer) {
        // Keep the page alive (a reload costs seconds); it draws again when the
        // host hands back a surface.
        virtualDisplay?.surface = null
    }

    override fun onVisibleAreaChanged(visibleArea: Rect) {
        this.visibleArea = Rect(visibleArea)
        pushInsets()
    }

    override fun onStableAreaChanged(stableArea: Rect) {
        if (visibleArea == null) onVisibleAreaChanged(stableArea)
    }

    // Gestures, in surface pixels from the host; the page takes CSS pixels.
    override fun onScroll(distanceX: Float, distanceY: Float) =
        js("pan(${num(-distanceX / density)},${num(-distanceY / density)})")

    override fun onFling(velocityX: Float, velocityY: Float) =
        js(
            "pan(${num(velocityX / density * FLING_SECONDS)}," +
                "${num(velocityY / density * FLING_SECONDS)},$FLING_MS)",
        )

    override fun onScale(focusX: Float, focusY: Float, scaleFactor: Float) {
        // A focus of -1 means a button or rotary zoom: zoom about the middle.
        if (focusX < 0f || focusY < 0f) {
            js("zoom(${num(scaleFactor)})")
        } else {
            js("zoom(${num(scaleFactor)},${num(focusX / density)},${num(focusY / density)})")
        }
    }

    override fun onClick(x: Float, y: Float) = js("tap(${num(x / density)},${num(y / density)})")

    // ---------------------------------------------------------------- page

    private fun showPresentation(target: Display) {
        val p = Presentation(carContext, target, android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen)
        p.window?.apply {
            // A window created from a service is not hardware accelerated by
            // default, and WebGL needs it.
            setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            )
            setBackgroundDrawable(ColorDrawable(Ink.GROUND))
        }
        val wv = createWebView(p.context)
        p.setContentView(wv)
        try {
            p.show()
        } catch (e: WindowManager.InvalidDisplayException) {
            Log.e(TAG, "car display went away", e)
            wv.destroy()
            return
        }
        presentation = p
        webView = wv
        wv.loadDataWithBaseURL(null, bootHtml("STARTING"), "text/html", "utf-8", null)
    }

    private fun onRuntime(state: NodeRuntime.State) {
        val wv = webView ?: return
        when (state) {
            is NodeRuntime.State.Ready -> if (loadedPort != state.port) {
                loadedPort = state.port
                pageReady = false
                // The car's layer choice rides in the share hash, so the first
                // frame already has the right layers on (core/share/state.js).
                val layers = Prefs(carContext).carLayers.sorted().joinToString(",")
                wv.loadUrl("http://127.0.0.1:${state.port}/?shell=car#v=1&layers=$layers")
            }
            is NodeRuntime.State.Failed ->
                wv.loadDataWithBaseURL(null, bootHtml("OPEN ARGUS ON THE PHONE"), "text/html", "utf-8", null)
            is NodeRuntime.State.Starting -> Unit
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun createWebView(context: Context): WebView {
        val wv = WebView(context)
        wv.setBackgroundColor(Ink.GROUND)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            // Nothing plays in the car: no gesture ever arrives to allow it.
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            setSupportZoom(false)
        }
        wv.addJavascriptInterface(HostBridge(), "ArgusCarHost")
        wv.webViewClient = object : WebViewClient() {
            // No browsing in the car: only the car shell loads.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !isOwnPage(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                if (isOwnPage(Uri.parse(url))) {
                    pageReady = true
                    pushState()
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "car WebView renderer gone (crash=${detail.didCrash()}); rebuilding")
                val p = presentation
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                webView = null
                pageReady = false
                loadedPort = 0
                if (p != null) {
                    val fresh = createWebView(p.context)
                    p.setContentView(fresh)
                    webView = fresh
                    onRuntime(NodeRuntime.state)
                }
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback,
            ) {
                callback.invoke(origin, isOwnPage(Uri.parse(origin)) && hasLocation(carContext), false)
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "car page: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        return wv
    }

    private fun isOwnPage(uri: Uri): Boolean =
        uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == loadedPort && loadedPort != 0

    /** Everything the page needs after a (re)load. */
    private fun pushState() {
        pushInsets()
        pushLayers()
        lastFix?.let { js(it) }
    }

    /** The area the host leaves uncovered (action strips, cards), as CSS-pixel insets. */
    private fun pushInsets() {
        val area = visibleArea ?: return
        if (surfaceWidth == 0 || surfaceHeight == 0) return
        val top = area.top / density
        val left = area.left / density
        val right = (surfaceWidth - area.right) / density
        val bottom = (surfaceHeight - area.bottom) / density
        js("setInsets(${num(top)},${num(right)},${num(bottom)},${num(left)})")
    }

    private fun onFix(fix: Location) {
        val heading = if (fix.hasBearing()) num(fix.bearing) else "null"
        val speed = if (fix.hasSpeed()) num(fix.speed) else "null"
        val accuracy = if (fix.hasAccuracy()) num(fix.accuracy) else "null"
        val call = "setLocation(${fix.latitude},${fix.longitude},$heading,$speed,$accuracy)"
        lastFix = call
        js(call)
    }

    private fun js(call: String) {
        val wv = webView ?: return
        if (!pageReady) return
        wv.evaluateJavascript("window.argusCar&&window.argusCar.$call", null)
    }

    private fun release() {
        pageReady = false
        loadedPort = 0
        webView?.let {
            it.stopLoading()
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        presentation?.dismiss()
        presentation = null
        virtualDisplay?.release()
        virtualDisplay = null
    }

    /** window.ArgusCarHost: the car page says when it is mounted, to get the current state. */
    inner class HostBridge {
        @JavascriptInterface
        fun ready() {
            main.post {
                pageReady = true
                pushState()
            }
        }
    }

    private companion object {
        const val TAG = "ArgusCar"
        const val DISPLAY_NAME = "argus-car"
        const val UI_SCALE = 1.25f
        const val FLING_SECONDS = 0.25f
        const val FLING_MS = 450

        fun num(v: Float): String = if (v.isFinite()) String.format(Locale.ROOT, "%.2f", v) else "0"

        fun bootHtml(message: String): String = """
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#0e0e0e;color:#fff;font-family:monospace}
body{display:flex;flex-direction:column;align-items:center;justify-content:center}
h1{margin:0;font-size:34px;letter-spacing:.35em;padding-left:.35em}
hr{width:132px;border:0;border-top:2px solid #fff;margin:10px 0 14px}
p{margin:0;color:#7a7a7a;font-size:13px;letter-spacing:.08em}</style></head>
<body><h1>ARGUS</h1><hr><p>ARGUS_BOOT : $message</p></body></html>
"""
    }
}

internal fun hasLocation(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

/**
 * The phone's location for the car map, from the platform LocationManager (no
 * Google Play services): GPS once a second, the network provider until GPS
 * has a fix.
 */
class CarLocationFeed(
    context: Context,
    private val onFix: (Location) -> Unit,
) : LocationListener {
    private val appContext = context.applicationContext
    private val manager = appContext.getSystemService(LocationManager::class.java)
    private var running = false
    private var lastGpsAt = 0L

    @SuppressLint("MissingPermission")
    fun start() {
        val lm = manager ?: return
        if (running || !hasLocation(appContext)) return
        running = true
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { it in lm.allProviders }
        for (p in providers) {
            try {
                lm.requestLocationUpdates(p, 1000L, 0f, this, Looper.getMainLooper())
            } catch (e: SecurityException) {
                Log.w("ArgusCar", "location $p refused", e)
            } catch (e: IllegalArgumentException) {
                Log.w("ArgusCar", "location $p unavailable", e)
            }
        }
        // A recent fix first, so the map does not wait for the GPS.
        providers
            .mapNotNull {
                try {
                    lm.getLastKnownLocation(it)
                } catch (_: SecurityException) {
                    null
                } catch (_: IllegalArgumentException) {
                    null
                }
            }
            .maxByOrNull { it.time }
            ?.let(onFix)
    }

    fun stop() {
        if (!running) return
        running = false
        manager?.removeUpdates(this)
    }

    override fun onLocationChanged(location: Location) {
        val now = SystemClock.elapsedRealtime()
        if (location.provider == LocationManager.GPS_PROVIDER) {
            lastGpsAt = now
        } else if (now - lastGpsAt < 10_000) {
            return // GPS is flowing: skip the coarser fixes
        }
        onFix(location)
    }

    // Abstract before API 30: implemented so older Android never hits them missing.
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    override fun onProviderEnabled(provider: String) = Unit

    override fun onProviderDisabled(provider: String) = Unit
}
