package net.h4ch1.argus

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.AssetManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL

/** JNI entry into nodejs-mobile (src/main/cpp/native-lib.cpp). */
object NodeBridge {
    init {
        System.loadLibrary("node")
        System.loadLibrary("native-lib")
    }

    /** Runs Node with these arguments on the calling thread; returns its exit code. */
    external fun startNodeWithArguments(arguments: Array<String>): Int
}

/** Where the app keeps its private files. Keys never leave app-private storage. */
class ArgusPaths(context: Context) {
    val root = File(context.filesDir, "argus")
    val keysFile = File(root, ".env")
    val logFile = File(root, "proxy.log")
    val portFile = File(root, "proxy.port")
    val configHome = File(root, "config")
    val project = File(context.filesDir, NodeProject.ASSET_ROOT)
}

/** Small settings shared by the phone UI, the car and the runtime. */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("argus", Context.MODE_PRIVATE)

    var port: Int
        get() = sp.getInt("port", NodeRuntime.DEFAULT_PORT)
        set(v) = sp.edit().putInt("port", v).apply()

    /** Serve the proxy on the LAN too (off: loopback only, the default). */
    var lan: Boolean
        get() = sp.getBoolean("lan", false)
        set(v) = sp.edit().putBoolean("lan", v).apply()

    /** Hide the system bars (full screen), on by default. */
    var immersive: Boolean
        get() = sp.getBoolean("immersive", true)
        set(v) = sp.edit().putBoolean("immersive", v).apply()

    /** The layers shown on the car screen. */
    var carLayers: Set<String>
        get() = sp.getStringSet("carLayers", null)?.toSet() ?: CAR_DEFAULT_LAYERS
        set(v) = sp.edit().putStringSet("carLayers", v.toSet()).apply()

    companion object {
        val CAR_DEFAULT_LAYERS = setOf("flights", "quakes")
    }
}

/**
 * Unpacks the Node project (the built globe, the proxy and its runtime
 * dependencies, staged by scripts/android-bundle.mjs) from the APK's assets to
 * app-private storage, on first run and after every install or update. The
 * staging script writes argus-manifest.json with every file, so no slow
 * directory listing of the assets is needed.
 */
object NodeProject {
    const val ASSET_ROOT = "nodejs-project"
    private const val MANIFEST = "argus-manifest.json"

    fun ensure(context: Context, progress: (Int) -> Unit): File {
        val target = File(context.filesDir, ASSET_ROOT)
        val stamp = File(context.filesDir, "$ASSET_ROOT.stamp")
        val manifest = context.assets.open("$ASSET_ROOT/$MANIFEST").bufferedReader().use {
            JSONObject(it.readText())
        }
        @Suppress("DEPRECATION")
        val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
        val want = "${manifest.optString("build")}:${pkg.lastUpdateTime}"
        if (File(target, "main.js").isFile && stamp.isFile && stamp.readText() == want) {
            return target
        }

        val files = manifest.getJSONArray("files")
        val tmp = File(context.filesDir, "$ASSET_ROOT.tmp")
        tmp.deleteRecursively()
        tmp.mkdirs()
        val buf = ByteArray(256 * 1024)
        var shown = -1
        for (i in 0 until files.length()) {
            val rel = files.getString(i)
            val parts = rel.split('/')
            if (rel.startsWith("/") || parts.any { it.isEmpty() || it == "." || it == ".." }) {
                throw IOException("bad path in $MANIFEST: $rel")
            }
            val out = File(tmp, rel)
            out.parentFile?.mkdirs()
            context.assets.open("$ASSET_ROOT/$rel", AssetManager.ACCESS_STREAMING).use { input ->
                FileOutputStream(out).use { output ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                    }
                }
            }
            val pct = (i + 1) * 100 / files.length()
            if (pct != shown) {
                shown = pct
                progress(pct)
            }
        }
        target.deleteRecursively()
        if (!tmp.renameTo(target)) throw IOException("could not move $tmp to $target")
        stamp.writeText(want)
        return target
    }
}

/**
 * The proxy, running on this phone: Node (nodejs-mobile) on a background
 * thread, serving the globe and every feed on http://127.0.0.1:<port>. Node
 * can start only once per process, so this is a process-wide singleton shared
 * by the phone activity and the Android Auto session. Restarting it (after new
 * keys, or the LAN switch) restarts the app process.
 */
object NodeRuntime {
    const val DEFAULT_PORT = 8787
    private const val TAG = "ArgusNode"
    private const val PORT_TRIES = 20
    private const val READY_TIMEOUT_MS = 120_000L

    sealed interface State {
        data class Starting(val step: String) : State
        data class Ready(val port: Int) : State
        data class Failed(val reason: String) : State
    }

    private val main = Handler(Looper.getMainLooper())
    private val listeners = LinkedHashSet<(State) -> Unit>()

    @Volatile
    var state: State = State.Starting("BOOT")
        private set

    @Volatile
    private var started = false

    @Volatile
    private var nodeExited = false

    /** Start the proxy once for this process (safe to call from anywhere). */
    fun start(context: Context) {
        val app = context.applicationContext
        synchronized(this) {
            if (started) return
            started = true
        }
        // V8 wants a deep stack; give Node's thread plenty.
        Thread(null, { boot(app) }, "argus-node", 16L * 1024 * 1024).start()
    }

    /**
     * Follow the runtime state on the main thread. Call on the main thread; the
     * listener gets the current state at once. Returns an unsubscribe.
     */
    fun observe(listener: (State) -> Unit): () -> Unit {
        listeners += listener
        listener(state)
        return { listeners -= listener }
    }

    /** The proxy's base URL once it is up, else null. */
    fun baseUrl(): String? = (state as? State.Ready)?.let { "http://127.0.0.1:${it.port}" }

    private fun publish(next: State) {
        state = next
        main.post { listeners.toList().forEach { it(next) } }
    }

    private fun boot(app: Context) {
        val paths = ArgusPaths(app)
        try {
            publish(State.Starting("UNPACK"))
            val project = NodeProject.ensure(app) { pct -> publish(State.Starting("UNPACK $pct%")) }
            paths.root.mkdirs()
            paths.configHome.mkdirs()
            paths.portFile.delete()

            val prefs = Prefs(app)
            val port = pickPort(prefs.port)
            // Node reads its settings from the environment (proxy/lib/config.js,
            // proxy/lib/env.js). Real environment values win over the keys file.
            setenv("HOME", app.filesDir.absolutePath)
            setenv("TMPDIR", app.cacheDir.absolutePath)
            setenv("XDG_CONFIG_HOME", paths.configHome.absolutePath)
            setenv("ARGUS_ENV_FILE", paths.keysFile.absolutePath)
            setenv("ARGUS_KEYS_FILE", paths.keysFile.absolutePath)
            setenv("ARGUS_PORT_FILE", paths.portFile.absolutePath)
            setenv("ARGUS_LOG_FILE", paths.logFile.absolutePath)
            setenv("PROXY_PORT", port.toString())
            setenv("PROXY_HOST", if (prefs.lan) "0.0.0.0" else "127.0.0.1")
            setenv("ARGUS_PLATFORM", "android-app")

            publish(State.Starting("PROXY_START"))
            Thread({ awaitHealth(app, paths) }, "argus-health").start()
            val entry = File(project, "main.js").absolutePath
            val code = NodeBridge.startNodeWithArguments(arrayOf("node", entry))
            nodeExited = true
            publish(State.Failed("Node stopped (exit code $code).\n\n${tail(paths.logFile)}"))
        } catch (t: Throwable) {
            Log.e(TAG, "proxy failed to start", t)
            nodeExited = true
            publish(State.Failed("${t.javaClass.simpleName}: ${t.message}\n\n${tail(paths.logFile)}"))
        }
    }

    private fun setenv(name: String, value: String) = Os.setenv(name, value, true)

    /** The preferred port when free, else the next free one from 8787 up (0: let Node choose). */
    private fun pickPort(preferred: Int): Int {
        val candidates = LinkedHashSet<Int>()
        candidates += preferred
        for (p in DEFAULT_PORT until DEFAULT_PORT + PORT_TRIES) candidates += p
        return candidates.firstOrNull { portFree(it) } ?: 0
    }

    private fun portFree(port: Int): Boolean =
        try {
            ServerSocket().use {
                it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            }
            true
        } catch (_: IOException) {
            false
        }

    private fun awaitHealth(app: Context, paths: ArgusPaths) {
        val deadline = SystemClock.elapsedRealtime() + READY_TIMEOUT_MS
        while (!nodeExited && SystemClock.elapsedRealtime() < deadline) {
            val port = paths.portFile.takeIf { it.isFile }?.readText()?.trim()?.toIntOrNull()
            if (port != null && healthy(port)) {
                Prefs(app).port = port
                publish(State.Ready(port))
                return
            }
            Thread.sleep(200)
        }
        if (!nodeExited) {
            publish(State.Failed("The proxy did not answer /health.\n\n${tail(paths.logFile)}"))
        }
    }

    /** True when our proxy answers /health on this port. */
    fun healthy(port: Int): Boolean =
        try {
            val c = URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection
            c.connectTimeout = 1000
            c.readTimeout = 3000
            c.useCaches = false
            try {
                c.responseCode == 200 &&
                    c.inputStream.bufferedReader().use { it.readText() }.contains("argus-proxy")
            } finally {
                c.disconnect()
            }
        } catch (_: IOException) {
            false
        }

    /** The last lines of the proxy log, for error screens. */
    fun tail(file: File, lines: Int = 40): String =
        try {
            if (file.isFile) file.readLines().takeLast(lines).joinToString("\n") else ""
        } catch (_: IOException) {
            ""
        }

    /**
     * Restart the app process (Node cannot be restarted in place): new keys and
     * the LAN switch take effect on the next start.
     */
    fun restartApp(context: Context) {
        val intent = Intent.makeRestartActivityTask(ComponentName(context, MainActivity::class.java))
        context.startActivity(intent)
        Runtime.getRuntime().exit(0)
    }
}
