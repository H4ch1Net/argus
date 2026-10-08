package net.h4ch1.argus

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The phone app: a full-screen WebView on the globe served by the proxy on
 * this phone (http://127.0.0.1:<port>/, the same app `npm start` serves), with
 * a native boot screen until the proxy answers. Location goes through the
 * Android permission; nothing here holds or sees a key.
 */
class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var splash: SplashView
    private var webView: WebView? = null
    private var loadedPort = 0
    private var unobserve: (() -> Unit)? = null
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var immersive = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (handleAction(intent)) return

        window.setBackgroundDrawable(ColorDrawable(Ink.GROUND))
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        root = FrameLayout(this).apply { setBackgroundColor(Ink.GROUND) }
        splash = SplashView(
            this,
            onSettings = { openSettings() },
            onRestart = { NodeRuntime.restartApp(this) },
        )
        root.addView(splash, FrameLayout.LayoutParams(MATCH, MATCH))
        setContentView(root)
        // Keep the page out from under the bars and the camera cutout (the bars
        // report no inset while hidden, so full screen really is full screen).
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        immersive = Prefs(this).immersive
        applyImmersive()

        NodeRuntime.start(this)
        unobserve = NodeRuntime.observe { onRuntime(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleAction(intent)
    }

    /** Launcher shortcuts (res/xml/shortcuts.xml). Returns true when the activity is going away. */
    private fun handleAction(intent: Intent?): Boolean {
        when (intent?.action) {
            ACTION_SETTINGS -> openSettings()
            ACTION_FULLSCREEN -> {
                val prefs = Prefs(this)
                prefs.immersive = !prefs.immersive
                immersive = prefs.immersive
                if (::root.isInitialized) applyImmersive()
            }
            ACTION_RESTART -> {
                NodeRuntime.restartApp(this)
                return true
            }
        }
        return false
    }

    private fun onRuntime(state: NodeRuntime.State) {
        when (state) {
            is NodeRuntime.State.Starting -> splash.setStep(state.step)
            is NodeRuntime.State.Failed -> splash.showError(state.reason)
            is NodeRuntime.State.Ready -> {
                splash.setStep("LOG_STREAM_CONNECTED")
                if (loadedPort != state.port) load(state.port)
            }
        }
    }

    private fun load(port: Int) {
        val wv = webView ?: createWebView().also { webView = it }
        loadedPort = port
        wv.loadUrl("http://127.0.0.1:$port/")
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun createWebView(): WebView {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val wv = WebView(this)
        wv.setBackgroundColor(Ink.GROUND)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = true
            allowFileAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        wv.addJavascriptInterface(AndroidBridge(), "ArgusAndroid")
        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                openOutside(request.url)

            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(WAKE_LOCK_SHIM, null)
                if (isOwnPage(Uri.parse(url))) splash.dismiss()
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page's renderer died (often GPU memory). Rebuild the WebView
                // and reload instead of letting the app crash.
                Log.w(TAG, "WebView renderer gone (crash=${detail.didCrash()}); reloading")
                root.removeView(view)
                view.destroy()
                if (webView === view) webView = null
                val port = loadedPort
                loadedPort = 0
                if (port != 0) load(port)
                return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback,
            ) {
                if (!isOwnPage(Uri.parse(origin))) {
                    callback.invoke(origin, false, false)
                } else if (hasLocationPermission()) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeo = origin to callback
                    requestPermissions(
                        arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                        ),
                        REQ_LOCATION,
                    )
                }
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                // Scene import (a JSON file): the system picker.
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    startActivityForResult(params.createIntent(), REQ_FILE)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "page: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        root.addView(wv, 0, FrameLayout.LayoutParams(MATCH, MATCH))
        return wv
    }

    /** Our own page stays in the WebView; any other link opens in the browser. */
    private fun openOutside(uri: Uri): Boolean {
        if (isOwnPage(uri)) return false
        if (uri.scheme == "http" || uri.scheme == "https" || uri.scheme == "mailto") {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (_: ActivityNotFoundException) {
                // nothing to open it with
            }
        }
        return true
    }

    private fun isOwnPage(uri: Uri): Boolean =
        uri.scheme == "http" &&
            (uri.host == "127.0.0.1" || uri.host == "localhost") &&
            (loadedPort == 0 || uri.port == loadedPort)

    private fun hasLocationPermission(): Boolean =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_LOCATION) return
        val granted = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
        pendingGeo?.let { (origin, callback) -> callback.invoke(origin, granted, false) }
        pendingGeo = null
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    private fun applyImmersive() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = false
        controller.isAppearanceLightNavigationBars = false
        if (immersive) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    override fun onResume() {
        super.onResume()
        // Per-WebView pause only: pauseTimers() is process-wide and would also
        // freeze the Android Auto map.
        webView?.onResume()
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        unobserve?.invoke()
        unobserve = null
        webView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }

    /** window.ArgusAndroid, for the page. Every call is harmless if misused. */
    inner class AndroidBridge {
        /** Keep the screen on while the page asks (cockpit mode). */
        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) = runOnUiThread {
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        /** Full screen (system bars hidden) on or off; remembered. */
        @JavascriptInterface
        fun setImmersive(on: Boolean) = runOnUiThread {
            immersive = on
            Prefs(this@MainActivity).immersive = on
            applyImmersive()
        }

        @JavascriptInterface
        fun isImmersive(): Boolean = immersive

        /** The native settings screen (keys file, LAN sharing, full screen, proxy log). */
        @JavascriptInterface
        fun openSettings() = runOnUiThread { this@MainActivity.openSettings() }

        /** Restart the app and its proxy (keys that only load at start). */
        @JavascriptInterface
        fun restart() = runOnUiThread { NodeRuntime.restartApp(this@MainActivity) }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    companion object {
        private const val TAG = "Argus"
        private const val MATCH = FrameLayout.LayoutParams.MATCH_PARENT
        private const val REQ_LOCATION = 1
        private const val REQ_FILE = 2
        const val ACTION_SETTINGS = "net.h4ch1.argus.action.SETTINGS"
        const val ACTION_RESTART = "net.h4ch1.argus.action.RESTART"
        const val ACTION_FULLSCREEN = "net.h4ch1.argus.action.FULLSCREEN"

        /**
         * Android WebView has no Screen Wake Lock API, so cockpit mode's
         * navigator.wakeLock.request('screen') maps onto setKeepScreenOn here.
         */
        private const val WAKE_LOCK_SHIM = """
(function () {
  if (!window.ArgusAndroid || 'wakeLock' in navigator) return;
  var held = 0;
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: function () {
        held += 1;
        window.ArgusAndroid.setKeepScreenOn(true);
        var released = false;
        return Promise.resolve({
          type: 'screen',
          get released() { return released; },
          onrelease: null,
          release: function () {
            if (!released) {
              released = true;
              held = Math.max(0, held - 1);
              if (!held) window.ArgusAndroid.setKeepScreenOn(false);
            }
            return Promise.resolve();
          },
          addEventListener: function () {},
          removeEventListener: function () {},
        });
      },
    },
  });
})();
"""
    }
}
