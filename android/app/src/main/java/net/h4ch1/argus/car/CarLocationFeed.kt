package net.h4ch1.argus.car

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.car.app.CarContext
import androidx.car.app.hardware.CarHardwareManager
import androidx.car.app.hardware.common.CarValue
import androidx.car.app.hardware.common.OnCarDataAvailableListener
import androidx.car.app.hardware.info.CarHardwareLocation
import androidx.car.app.hardware.info.CarSensors
import androidx.car.app.versioning.CarAppApiLevels
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

/** Where a fix came from, the most trusted first (the order the feed prefers them in). */
enum class FixSource(val label: String) {
    /** The car's own GPS, handed over by Android Auto (car API level 3 and up). */
    CAR("CAR"),

    /** Android's fused location (Android 12 and up): GPS, Wi-Fi, cell and sensors together. */
    FUSED("FUSED"),

    /** The phone's GPS. */
    GPS("GPS"),

    /** Wi-Fi and cell only: coarse, until something better speaks. */
    NETWORK("NET"),
}

/**
 * The position for the car map. On the car display Android counts the app as
 * in the background, and a locked phone may stop handing a background app
 * its own fixes (the arrow stood still while the car drove). So the feed
 * listens to every source at once, best first: the car's own GPS through
 * Android Auto (its data reaches the app over the car connection, whatever
 * the phone thinks of the app), Android's fused location, the phone's GPS,
 * and the network. A fix is used only while no better source has spoken in
 * the last PREFER_MS, so a dropout falls back at once and a recovery takes
 * over at once.
 *
 * It runs for the whole car session (CarMapRenderer), not only while the
 * map is in front: a moment behind another screen must not leave it off.
 * The renderer's watchdog calls restart() when no fix has been used for a
 * while, which asks every source again.
 *
 * What each source did on a drive (how many fixes each sent, which were
 * used, whether the foreground service started, each start, stop and
 * restart) goes to CarGpsLog, which the phone's Settings shows under CAR
 * GPS: after a drive it says what worked.
 */
class CarLocationFeed(
    private val carContext: CarContext,
    private val onFix: (Location, FixSource) -> Unit,
) {
    private val appContext = carContext.applicationContext
    private val manager = appContext.getSystemService(LocationManager::class.java)
    private val executor = ContextCompat.getMainExecutor(appContext)
    /** Whether the sources are being listened to. */
    var running = false
        private set

    // When the last fix was used, and when the sources were last asked
    // (elapsedRealtime); quietMs() measures from the later.
    private var usedAt = 0L
    private var askedAt = 0L
    private val heardAt = LongArray(FixSource.values().size)
    private var sensors: CarSensors? = null

    /** One listener per platform provider, so each fix knows where it came from. */
    private inner class Feed(val source: FixSource) : LocationListener {
        override fun onLocationChanged(location: Location) = offer(location, source)

        // Abstract before API 30: implemented so older Android never hits them missing.
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

        override fun onProviderEnabled(provider: String) = Unit

        override fun onProviderDisabled(provider: String) = Unit
    }

    private val fused = Feed(FixSource.FUSED)
    private val gps = Feed(FixSource.GPS)
    private val network = Feed(FixSource.NETWORK)

    private val onCar = OnCarDataAvailableListener<CarHardwareLocation> { data ->
        val value = data.location
        if (value.status == CarValue.STATUS_SUCCESS) value.value?.let { offer(it, FixSource.CAR) }
    }

    /** Listen to every source; false without the location permission. */
    fun start(): Boolean {
        if (running) return true
        if (!hasLocation(appContext)) return false
        running = true
        CarGpsLog.count(CarGpsLog.Event.START)
        listen(replay = true)
        return true
    }

    /** How long since a fix was used (or the sources were asked), in ms. */
    fun quietMs(): Long = SystemClock.elapsedRealtime() - maxOf(usedAt, askedAt)

    /**
     * Ask every source again: the listeners go and come back (the car's and
     * the platform's), for when the fixes stopped without a word.
     */
    fun restart() {
        if (!running) return
        CarGpsLog.count(CarGpsLog.Event.RESTART)
        unlisten()
        heardAt.fill(0L)
        listen(replay = false)
    }

    @SuppressLint("MissingPermission")
    private fun listen(replay: Boolean) {
        askedAt = SystemClock.elapsedRealtime()
        startCar()
        val lm = manager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && lm.hasProvider(LocationManager.FUSED_PROVIDER)) {
            try {
                val request = android.location.LocationRequest.Builder(INTERVAL_MS)
                    .setQuality(android.location.LocationRequest.QUALITY_HIGH_ACCURACY)
                    .setMinUpdateIntervalMillis(INTERVAL_MS / 2)
                    .build()
                lm.requestLocationUpdates(LocationManager.FUSED_PROVIDER, request, executor, fused)
            } catch (e: RuntimeException) {
                Log.w(TAG, "location fused refused", e)
                CarGpsLog.note("FUSED: ${e.javaClass.simpleName}")
            }
        }
        for ((provider, feed) in listOf(LocationManager.GPS_PROVIDER to gps, LocationManager.NETWORK_PROVIDER to network)) {
            if (provider !in lm.allProviders) continue
            try {
                lm.requestLocationUpdates(provider, INTERVAL_MS, 0f, feed, Looper.getMainLooper())
            } catch (e: RuntimeException) {
                Log.w(TAG, "location $provider refused", e)
                CarGpsLog.note("${feed.source.label}: ${e.javaClass.simpleName}")
            }
        }
        // The phone's last fix first, so the map has somewhere to be; it
        // carries its age, and the page shows NO GPS until a live one comes.
        if (!replay) return
        listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { it in lm.allProviders }
            .mapNotNull {
                try {
                    lm.getLastKnownLocation(it)
                } catch (_: RuntimeException) {
                    null
                }
            }
            .maxByOrNull { it.elapsedRealtimeNanos }
            ?.let { onFix(it, FixSource.NETWORK) }
    }

    fun stop() {
        if (!running) return
        running = false
        CarGpsLog.count(CarGpsLog.Event.STOP)
        unlisten()
        CarGpsLog.save(appContext)
    }

    private fun unlisten() {
        sensors?.let { s ->
            try {
                s.removeCarHardwareLocationListener(onCar)
            } catch (e: RuntimeException) {
                Log.w(TAG, "car location remove", e)
            }
        }
        sensors = null
        manager?.let { lm ->
            listOf(fused, gps, network).forEach {
                try {
                    lm.removeUpdates(it)
                } catch (e: RuntimeException) {
                    Log.w(TAG, "location remove", e)
                }
            }
        }
    }

    /** The car's own GPS (car API level 3 and up, with the location permission). */
    private fun startCar() {
        if (sensors != null) return
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_3) {
            CarGpsLog.note("CAR: host API ${carContext.carAppApiLevel}")
            return
        }
        try {
            val s = carContext.getCarService(CarHardwareManager::class.java).carSensors
            s.addCarHardwareLocationListener(CarSensors.UPDATE_RATE_FASTEST, executor, onCar)
            sensors = s
        } catch (e: RuntimeException) {
            // A host without the car's location, or app-projected missing.
            Log.w(TAG, "car location unavailable", e)
            CarGpsLog.note("CAR: ${e.javaClass.simpleName}")
        }
    }

    private fun offer(fix: Location, source: FixSource) {
        if (!running) return
        val now = SystemClock.elapsedRealtime()
        heardAt[source.ordinal] = now
        CarGpsLog.heard(source)
        // A better source heard from lately wins.
        for (better in 0 until source.ordinal) {
            if (heardAt[better] != 0L && now - heardAt[better] < PREFER_MS) {
                CarGpsLog.tick(appContext)
                return
            }
        }
        usedAt = now
        CarGpsLog.used(source)
        CarGpsLog.tick(appContext)
        onFix(fix, source)
    }

    private companion object {
        const val TAG = "ArgusCar"
        const val INTERVAL_MS = 1000L
        const val PREFER_MS = 3000L
    }
}

/**
 * A record of the last car drive's location, kept for the phone's Settings
 * (CAR GPS): when it began, whether the foreground service went to the
 * foreground, how many fixes each source sent and how many were used, how
 * often the feed started, stopped and was restarted (and the map was hidden
 * and shown), the last fix, and the first few refusals. One record per car
 * session; saved every SAVE_MS while it runs and when it stops. Main thread
 * only.
 */
object CarGpsLog {
    /** What the feed and the map did, counted per drive. */
    enum class Event(val label: String) {
        START("START"),
        STOP("STOP"),
        RESTART("RESTART"),
        HIDDEN("HIDDEN"),
        SHOWN("SHOWN"),
    }

    private const val FILE = "car_gps"
    private const val KEY = "last"
    private const val SAVE_MS = 15_000L
    private val heard = IntArray(FixSource.values().size)
    private val used = IntArray(FixSource.values().size)
    private val events = IntArray(Event.values().size)
    private var began = 0L
    private var lastFix = 0L
    private var foreground = "--"
    private val notes = mutableListOf<String>()
    private var savedAt = 0L

    fun begin(context: Context) {
        heard.fill(0)
        used.fill(0)
        events.fill(0)
        notes.clear()
        began = System.currentTimeMillis()
        lastFix = 0L
        save(context)
    }

    fun heard(source: FixSource) {
        heard[source.ordinal]++
    }

    fun used(source: FixSource) {
        used[source.ordinal]++
        lastFix = System.currentTimeMillis()
    }

    fun count(event: Event) {
        events[event.ordinal]++
    }

    /** "ON", or why the location service could not go to the foreground. */
    fun foreground(state: String) {
        foreground = state.take(80)
    }

    fun note(text: String) {
        if (notes.size < 4 && text !in notes) notes += text.take(80)
    }

    fun tick(context: Context) {
        if (SystemClock.elapsedRealtime() - savedAt >= SAVE_MS) save(context)
    }

    fun save(context: Context) {
        if (began == 0L) return
        savedAt = SystemClock.elapsedRealtime()
        val o = JSONObject()
            .put("began", began)
            .put("lastFix", lastFix)
            .put("foreground", foreground)
            .put("notes", notes.joinToString(" | "))
        for (s in FixSource.values()) {
            o.put("heard_${s.name}", heard[s.ordinal]).put("used_${s.name}", used[s.ordinal])
        }
        for (e in Event.values()) o.put("event_${e.name}", events[e.ordinal])
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(KEY, o.toString()).apply()
    }

    /** The last drive in a few lines for Settings; null before any. */
    fun summary(context: Context): String? {
        val raw = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
        val o = try {
            JSONObject(raw)
        } catch (_: Exception) {
            return null
        }
        val time = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
        val count = { prefix: String ->
            FixSource.values().joinToString(" · ") { "${it.label} ${o.optInt("${prefix}_${it.name}")}" }
        }
        val last = o.optLong("lastFix")
        return buildString {
            append("DRIVE ").append(time.format(Date(o.optLong("began"))))
            append("\nFOREGROUND ").append(o.optString("foreground", "--"))
            append("\nUSED  ").append(count("used"))
            append("\nHEARD ").append(count("heard"))
            if (o.has("event_START")) {
                append("\nFEED ").append(Event.values().joinToString(" · ") { "${it.label} ${o.optInt("event_${it.name}")}" })
            }
            append("\nLAST FIX ").append(if (last > 0) time.format(Date(last)) else "NONE")
            o.optString("notes").takeIf { it.isNotEmpty() }?.let { append("\n").append(it) }
        }
    }
}
