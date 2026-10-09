package net.h4ch1.argus.car

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.DrawableRes
import androidx.car.app.CarContext
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.DateTimeWithZone
import androidx.car.app.model.Distance
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.navigation.model.Destination
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import androidx.car.app.navigation.model.TravelEstimate
import androidx.car.app.navigation.model.Trip
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import net.h4ch1.argus.Prefs
import net.h4ch1.argus.R
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * What the car page reports through window.ArgusCarHost
 * (CarMapRenderer.HostBridge), delivered on the main thread.
 */
interface CarPageListener {
    /** The page mounted (a first load, or a reload after its renderer died). */
    fun onPageMounted() {}

    fun onSearchResults(reqId: String, json: String) {}

    fun onRoutes(json: String) {}

    fun onNav(json: String) {}
}

// ------------------------------------------------------------------ model
// The page sends display-ready JSON (shell-car/nav.js); these read it back,
// checking every field, since a bad value must never reach a template builder.

private fun JSONObject.str(name: String, max: Int = 160): String =
    if (isNull(name)) "" else optString(name).trim().take(max)

private fun JSONObject.num(name: String): Double? =
    if (isNull(name)) null else optDouble(name, Double.NaN).takeIf { it.isFinite() }

/** A distance as the page rounded it for display (shell-car/nav.js carDistance). */
data class CarDistance(val value: Double, val unit: Int) {
    fun toDistance(): Distance = Distance.create(value, unit)

    companion object {
        fun parse(o: JSONObject?): CarDistance? {
            if (o == null) return null
            val v = o.num("value")?.takeIf { it >= 0 } ?: return null
            val unit = when (o.str("unit")) {
                "m" -> Distance.UNIT_METERS
                "km" -> Distance.UNIT_KILOMETERS
                "km_p1" -> Distance.UNIT_KILOMETERS_P1
                "ft" -> Distance.UNIT_FEET
                "mi" -> Distance.UNIT_MILES
                "mi_p1" -> Distance.UNIT_MILES_P1
                else -> return null
            }
            return CarDistance(v, unit)
        }

        /**
         * The same rounding as the page, for distances the app works out
         * itself (recent destinations): metres in steps of 10 or 50, then
         * kilometres with one decimal under 10; in miles where the phone's
         * region drives in miles.
         */
        fun of(m: Double): CarDistance {
            val d = max(0.0, m)
            if (Locale.getDefault().country.uppercase(Locale.ROOT) in MILE_REGIONS) {
                val mi = d / 1609.344
                return when {
                    mi < 0.1 -> CarDistance(((d * 3.28084) / 50).roundToLong() * 50.0, Distance.UNIT_FEET)
                    mi < 10 -> CarDistance((mi * 10).roundToLong() / 10.0, Distance.UNIT_MILES_P1)
                    else -> CarDistance(mi.roundToLong().toDouble(), Distance.UNIT_MILES)
                }
            }
            if (d < 1000) {
                val step = if (d < 300) 10 else 50
                val v = (d / step).roundToLong() * step.toDouble()
                return if (v >= 1000) CarDistance(1.0, Distance.UNIT_KILOMETERS_P1) else CarDistance(v, Distance.UNIT_METERS)
            }
            val km = d / 1000
            return if (km < 10) {
                CarDistance((km * 10).roundToLong() / 10.0, Distance.UNIT_KILOMETERS_P1)
            } else {
                CarDistance(km.roundToLong().toDouble(), Distance.UNIT_KILOMETERS)
            }
        }

        private val MILE_REGIONS = setOf("US", "GB", "LR", "MM")
    }
}

/** A place to go: a search result or a recent destination. */
data class CarPlace(
    val id: String,
    val name: String,
    val detail: String,
    val kind: String,
    val lat: Double,
    val lon: Double,
    val distance: CarDistance? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("name", name)
        .put("detail", detail)
        .put("kind", kind)
        .put("lat", lat)
        .put("lon", lon)

    /** The same place (search results carry fresh ids): within about 30 m. */
    fun sameAs(o: CarPlace): Boolean = abs(lat - o.lat) < 3e-4 && abs(lon - o.lon) < 3e-4

    companion object {
        fun parse(o: JSONObject?): CarPlace? {
            if (o == null) return null
            val lat = o.num("lat") ?: return null
            val lon = o.num("lon") ?: return null
            if (abs(lat) > 90 || abs(lon) > 180) return null
            val name = o.str("name", 120)
            if (name.isEmpty()) return null
            return CarPlace(
                id = o.str("id", 120).ifEmpty { "$lat,$lon" },
                name = name,
                detail = o.str("detail"),
                kind = o.str("kind", 40),
                lat = lat,
                lon = lon,
                distance = CarDistance.parse(o.optJSONObject("distance")),
            )
        }
    }
}

/** One candidate route for the preview list (no geometry: the page draws it). */
data class CarRoute(
    val id: String,
    val summary: String,
    val distance: CarDistance?,
    val durationS: Long,
    val trafficDelayS: Long,
    val signals: Int,
    val avoidHighways: Boolean,
) {
    companion object {
        fun parse(o: JSONObject?): CarRoute? {
            if (o == null) return null
            val id = o.str("id", 120)
            val duration = o.num("durationS")?.takeIf { it >= 0 } ?: return null
            if (id.isEmpty()) return null
            return CarRoute(
                id = id,
                summary = o.str("summary", 120),
                distance = CarDistance.parse(o.optJSONObject("distance")),
                durationS = duration.roundToLong(),
                trafficDelayS = (o.num("trafficDelayS") ?: 0.0).roundToLong().coerceAtLeast(0),
                signals = (o.num("signals") ?: 0.0).toInt().coerceAtLeast(0),
                avoidHighways = o.optBoolean("avoidHighways", false),
            )
        }
    }
}

/** A maneuver in the Car App Library's terms, as the page mapped it (shell-car/nav.js carManeuver). */
data class CarManeuver(val type: Int, val icon: String, val exitNumber: Int) {
    fun build(context: CarContext): Maneuver {
        var t = if (type in 0..Maneuver.TYPE_FERRY_TRAIN_RIGHT) type else Maneuver.TYPE_UNKNOWN
        // The page never sends exit angles; an exit number it lacks makes the
        // "enter and exit" types invalid, so those fall back to a plain entry.
        t = when (t) {
            Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW_WITH_ANGLE -> Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW
            Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW_WITH_ANGLE -> Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW
            else -> t
        }
        val withExit = t == Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW || t == Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW
        if (withExit && exitNumber < 1) {
            t = if (t == Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CW) {
                Maneuver.TYPE_ROUNDABOUT_ENTER_CW
            } else {
                Maneuver.TYPE_ROUNDABOUT_ENTER_CCW
            }
        }
        val b = Maneuver.Builder(t).setIcon(maneuverIcon(context, icon))
        if (withExit && exitNumber >= 1) b.setRoundaboutExitNumber(exitNumber)
        return b.build()
    }

    companion object {
        fun parse(o: JSONObject?): CarManeuver? {
            if (o == null) return null
            val type = o.num("type")?.toInt() ?: return null
            return CarManeuver(type, o.str("icon", 32), (o.num("exitNumber") ?: 0.0).toInt())
        }
    }
}

/** A step of the route: what to do, and onto which road. */
data class NavStep(val maneuver: CarManeuver?, val instruction: String, val roadName: String) {
    fun toStep(context: CarContext): Step {
        val cue = instruction.ifEmpty { roadName }
        val b = if (cue.isNotEmpty()) Step.Builder(cue) else Step.Builder()
        maneuver?.let { b.setManeuver(it.build(context)) }
        if (roadName.isNotEmpty()) b.setRoad(roadName)
        return b.build()
    }

    companion object {
        fun parse(o: JSONObject?): NavStep? {
            if (o == null) return null
            return NavStep(CarManeuver.parse(o.optJSONObject("maneuver")), o.str("instruction"), o.str("roadName", 120))
        }
    }
}

/** The page's navigation state (ArgusCarHost.nav, shell-car/nav.js navPayload). */
data class NavInfo(
    val status: String,
    val routeId: String,
    val stepIndex: Int,
    val step: NavStep?,
    val stepDistance: CarDistance?,
    val timeToStepS: Long?,
    val then: NavStep?,
    val currentRoad: String,
    val remaining: CarDistance?,
    val durationRemainingS: Long?,
    val eta: Long?,
    val trafficDelayS: Long,
    val destinationName: String,
) {
    /** Remaining distance, time and arrival at the destination, when known. */
    fun destinationEstimate(): TravelEstimate? {
        val d = remaining ?: return null
        val at = eta ?: return null
        val b = TravelEstimate.Builder(d.toDistance(), DateTimeWithZone.create(at, TimeZone.getDefault()))
            .setRemainingTimeSeconds(max(0L, durationRemainingS ?: 0L))
        // A long traffic delay shows in the routing card's colours, as in other
        // navigation apps; the rest stays white.
        if (trafficDelayS >= HEAVY_TRAFFIC_S) b.setRemainingTimeColor(CarColor.YELLOW)
        return b.build()
    }

    /** Distance and time to the next maneuver (the cluster display's step estimate). */
    fun stepEstimate(): TravelEstimate? {
        val d = stepDistance ?: return null
        val s = max(0L, timeToStepS ?: return null)
        return TravelEstimate.Builder(d.toDistance(), DateTimeWithZone.create(System.currentTimeMillis() + s * 1000, TimeZone.getDefault()))
            .setRemainingTimeSeconds(s)
            .build()
    }

    companion object {
        private const val HEAVY_TRAFFIC_S = 300L

        fun parse(json: String): NavInfo? = try {
            val o = JSONObject(json)
            val step = if (o.isNull("maneuver") && o.str("instruction").isEmpty()) {
                null
            } else {
                NavStep(CarManeuver.parse(o.optJSONObject("maneuver")), o.str("instruction"), o.str("roadName", 120))
            }
            NavInfo(
                status = o.str("status", 20),
                routeId = o.str("routeId", 120),
                stepIndex = (o.num("stepIndex") ?: 0.0).toInt(),
                step = step,
                stepDistance = CarDistance.parse(o.optJSONObject("stepDistance")),
                timeToStepS = o.num("timeToStepS")?.roundToLong(),
                then = NavStep.parse(o.optJSONObject("then")),
                currentRoad = o.str("currentRoad", 120),
                remaining = CarDistance.parse(o.optJSONObject("remaining")),
                durationRemainingS = o.num("durationRemainingS")?.roundToLong(),
                eta = o.num("eta")?.toLong(),
                trafficDelayS = (o.num("trafficDelayS") ?: 0.0).roundToLong(),
                destinationName = o.optJSONObject("destination")?.str("name", 120).orEmpty(),
            )
        } catch (e: JSONException) {
            Log.w(TAG, "bad nav state from the page", e)
            null
        }
    }
}

data class SearchResult(val places: List<CarPlace>, val error: String?)

data class RoutesResult(val routes: List<CarRoute>, val error: String?)

/** The ctOS maneuver glyph for a page icon name (res/drawable/ic_nav_*, from shell-car/maneuvers.js). */
@DrawableRes
fun maneuverIconRes(name: String): Int = when (name) {
    "turn_right" -> R.drawable.ic_nav_turn_right
    "turn_left" -> R.drawable.ic_nav_turn_left
    "slight_right" -> R.drawable.ic_nav_slight_right
    "slight_left" -> R.drawable.ic_nav_slight_left
    "sharp_right" -> R.drawable.ic_nav_sharp_right
    "sharp_left" -> R.drawable.ic_nav_sharp_left
    "uturn_left" -> R.drawable.ic_nav_uturn_left
    "uturn_right" -> R.drawable.ic_nav_uturn_right
    "fork_right" -> R.drawable.ic_nav_fork_right
    "fork_left" -> R.drawable.ic_nav_fork_left
    "merge_right" -> R.drawable.ic_nav_merge_right
    "merge_left" -> R.drawable.ic_nav_merge_left
    "merge" -> R.drawable.ic_nav_merge
    "ramp_right" -> R.drawable.ic_nav_ramp_right
    "ramp_left" -> R.drawable.ic_nav_ramp_left
    "roundabout_ccw" -> R.drawable.ic_nav_roundabout_ccw
    "roundabout_cw" -> R.drawable.ic_nav_roundabout_cw
    "depart" -> R.drawable.ic_nav_depart
    "arrive" -> R.drawable.ic_nav_arrive
    "arrive_left" -> R.drawable.ic_nav_arrive_left
    "arrive_right" -> R.drawable.ic_nav_arrive_right
    else -> R.drawable.ic_nav_straight
}

/** Maneuver glyphs are white by design: drawn as they are, never tinted. */
fun maneuverIcon(context: CarContext, name: String): CarIcon =
    CarIcon.Builder(IconCompat.createWithResource(context, maneuverIconRes(name))).build()

// ---------------------------------------------------------------- session

/**
 * Turn-by-turn for one car session: the state the Android Auto screens share
 * (MapScreen, SearchScreen, RoutePreviewScreen) and the bridge to the car
 * page, which searches, plans and follows the route with the navigator
 * (shell-car/index.js, core/nav/navigator.js):
 *
 *   host -> page   search(query, reqId)        page -> host   searchResults(reqId, json)
 *                  preview(placeJson, optsJson)                routes(json)
 *                  selectRoute(id), navigate(routeId), stopNav()
 *                                                              nav(json), about once a second
 *
 * It tells Android Auto when navigation starts and ends (NavigationManager),
 * stops when Android Auto asks (another app, or the car, starts navigating),
 * sends the trip to the car's cluster display (updateTrip), and keeps the
 * last five destinations. If the page reloads mid-route (its renderer died),
 * the route is planned again to the same destination and followed on.
 */
class CarNav(
    private val carContext: CarContext,
    private val renderer: CarMapRenderer,
    lifecycle: Lifecycle,
) : CarPageListener, NavigationManagerCallback, DefaultLifecycleObserver {
    private val main = Handler(Looper.getMainLooper())
    private val prefs = Prefs(carContext)
    private val manager: NavigationManager = carContext.getCarService(NavigationManager::class.java)
    private val listeners = LinkedHashSet<() -> Unit>()
    private val searches = HashMap<String, (SearchResult) -> Unit>()
    private var routeRequest: Pair<String, (RoutesResult) -> Unit>? = null
    private var seq = 0
    private val endAfterArrival = Runnable { if (info?.status == "arrived") stop() }

    /** Navigating, as far as Android Auto knows (navigationStarted, not yet ended). */
    var navigating = false
        private set

    /** Where the current drive goes. */
    var destination: CarPlace? = null
        private set

    /** The page's latest progress; null until it sends one (the card shows loading). */
    var info: NavInfo? = null
        private set

    init {
        // Must be set before navigationStarted(), on the main thread.
        manager.setNavigationManagerCallback(this)
        lifecycle.addObserver(this)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        main.removeCallbacksAndMessages(null)
        searches.clear()
        routeRequest = null
        listeners.clear()
    }

    /** Follow changes (screens invalidate). Returns an unsubscribe. */
    fun observe(fn: () -> Unit): () -> Unit {
        listeners += fn
        return { listeners -= fn }
    }

    private fun changed() = listeners.toList().forEach { it() }

    // ------------------------------------------------------------- search

    fun search(query: String, done: (SearchResult) -> Unit) {
        seq += 1
        val id = "s$seq"
        searches[id] = done
        if (!renderer.search(query, id)) {
            searches.remove(id)
            done(SearchResult(emptyList(), OFFLINE))
            return
        }
        main.postDelayed({ searches.remove(id)?.invoke(SearchResult(emptyList(), TIMEOUT)) }, SEARCH_TIMEOUT_MS)
    }

    override fun onSearchResults(reqId: String, json: String) {
        val done = searches.remove(reqId) ?: return
        try {
            val o = JSONObject(json)
            val arr = o.optJSONArray("results") ?: JSONArray()
            val places = (0 until minOf(arr.length(), MAX_RESULTS)).mapNotNull { CarPlace.parse(arr.optJSONObject(it)) }
            done(SearchResult(places, o.str("error", 80).ifEmpty { null }))
        } catch (e: JSONException) {
            Log.w(TAG, "bad search results from the page", e)
            done(SearchResult(emptyList(), TIMEOUT))
        }
    }

    /** The last five destinations, newest first, each with its distance from here. */
    fun recents(): List<CarPlace> {
        val here = renderer.lastLocation
        return try {
            val arr = JSONArray(prefs.carRecents)
            (0 until minOf(arr.length(), MAX_RECENTS)).mapNotNull { i ->
                val p = CarPlace.parse(arr.optJSONObject(i)) ?: return@mapNotNull null
                if (here == null) {
                    p
                } else {
                    val out = FloatArray(1)
                    android.location.Location.distanceBetween(here.latitude, here.longitude, p.lat, p.lon, out)
                    p.copy(distance = CarDistance.of(out[0].toDouble()))
                }
            }
        } catch (e: JSONException) {
            emptyList()
        }
    }

    private fun addRecent(place: CarPlace) {
        val list = listOf(place) + recents().filterNot { it.sameAs(place) }
        prefs.carRecents = JSONArray(list.take(MAX_RECENTS).map { it.toJson() }).toString()
    }

    // ------------------------------------------------------------ preview

    /** Plan up to three routes to a place; the page draws them on the map. */
    fun preview(place: CarPlace, avoidHighways: Boolean, done: (RoutesResult) -> Unit) {
        seq += 1
        val id = "r$seq"
        routeRequest = id to done
        val opts = JSONObject().put("reqId", id).put("avoidHighways", avoidHighways)
        if (!renderer.preview(place.toJson().toString(), opts.toString())) {
            routeRequest = null
            done(RoutesResult(emptyList(), OFFLINE))
            return
        }
        main.postDelayed({
            val pending = routeRequest
            if (pending != null && pending.first == id) {
                routeRequest = null
                pending.second(RoutesResult(emptyList(), TIMEOUT))
            }
        }, ROUTE_TIMEOUT_MS)
    }

    override fun onRoutes(json: String) {
        try {
            val o = JSONObject(json)
            val pending = routeRequest ?: return
            // An answer to an older request (the driver toggled, or went back).
            if (o.str("reqId", 40) != pending.first) return
            routeRequest = null
            val arr = o.optJSONArray("routes") ?: JSONArray()
            val routes = (0 until minOf(arr.length(), MAX_ROUTES)).mapNotNull { CarRoute.parse(arr.optJSONObject(it)) }
            pending.second(RoutesResult(routes, o.str("error", 80).ifEmpty { null }))
        } catch (e: JSONException) {
            Log.w(TAG, "bad routes from the page", e)
        }
    }

    fun selectRoute(id: String) = renderer.selectRoute(id)

    /** Back out of the route preview without driving: the page clears the routes. */
    fun cancelPreview() {
        routeRequest = null
        if (!navigating) renderer.stopNav()
    }

    // --------------------------------------------------------- navigation

    fun start(place: CarPlace, routeId: String) {
        main.removeCallbacks(endAfterArrival)
        destination = place
        info = null
        if (!navigating) {
            navigating = true
            try {
                manager.navigationStarted()
            } catch (e: RuntimeException) {
                Log.w(TAG, "navigationStarted refused", e)
            }
        }
        renderer.navigate(routeId)
        addRecent(place)
        changed()
    }

    /** END, arrival, or Android Auto asking (onStopNavigation). */
    fun stop() {
        main.removeCallbacks(endAfterArrival)
        val was = navigating
        navigating = false
        destination = null
        info = null
        renderer.stopNav()
        if (was) {
            try {
                manager.navigationEnded()
            } catch (e: RuntimeException) {
                Log.w(TAG, "navigationEnded refused", e)
            }
        }
        changed()
    }

    override fun onStopNavigation() = stop()

    override fun onNav(json: String) {
        val next = NavInfo.parse(json) ?: return
        when (next.status) {
            "navigating", "rerouting", "arrived" -> {
                if (!navigating) return
                val arrivedNow = next.status == "arrived" && info?.status != "arrived"
                info = next
                if (arrivedNow) main.postDelayed(endAfterArrival, ARRIVED_END_MS)
                updateTrip(next)
                changed()
            }
            // The page dropped the route (it could not start it, or stopped on
            // its own): the host stops too. While the page is being re-planned
            // after a reload (resume) its idle state is expected.
            "idle" -> if (navigating && !resuming) stop()
            else -> Unit
        }
    }

    private var resuming = false

    override fun onPageMounted() {
        val dest = destination
        if (navigating && dest != null) resume(dest, 1)
    }

    // The page reloaded mid-route: plan to the same place again and follow the
    // best route. The navigator reaches the page a moment after it mounts, so
    // a few tries.
    private fun resume(dest: CarPlace, attempt: Int) {
        resuming = true
        info = null
        changed()
        preview(dest, prefs.carAvoidHighways) { result ->
            if (!navigating || destination !== dest) {
                resuming = false
                return@preview
            }
            val first = result.routes.firstOrNull()
            if (first != null) {
                resuming = false
                renderer.navigate(first.id)
            } else if (attempt < RESUME_TRIES) {
                main.postDelayed({ if (navigating && destination === dest) resume(dest, attempt + 1) }, RESUME_RETRY_MS)
            } else {
                resuming = false
                stop()
            }
        }
    }

    /** The routing card: the next maneuver and the one after, arrival, or loading. */
    fun navigationInfo(): NavigationTemplate.NavigationInfo {
        val n = info
        if (n?.status == "arrived") {
            val b = MessageInfo.Builder(carContext.getString(R.string.car_arrived))
                .setImage(maneuverIcon(carContext, "arrive"))
            val name = destination?.name ?: n.destinationName
            if (name.isNotEmpty()) b.setText(name)
            return b.build()
        }
        val step = n?.takeIf { it.status == "navigating" }?.step
        val distance = n?.stepDistance
        if (step == null || distance == null) return RoutingInfo.Builder().setLoading(true).build()
        val b = RoutingInfo.Builder().setCurrentStep(step.toStep(carContext), distance.toDistance())
        n.then?.let { b.setNextStep(it.toStep(carContext)) }
        return b.build()
    }

    // The trip for the car's cluster display, where the car has one.
    private fun updateTrip(n: NavInfo) {
        try {
            val trip = Trip.Builder()
            val dest = destination
            val estimate = n.destinationEstimate()
            if (dest != null && estimate != null) {
                val d = Destination.Builder().setName(dest.name)
                if (dest.detail.isNotEmpty()) d.setAddress(dest.detail)
                trip.addDestination(d.build(), estimate)
            }
            if (n.status == "rerouting") {
                trip.setLoading(true)
            } else if (n.status == "navigating") {
                val step = n.step
                val stepEstimate = n.stepEstimate()
                if (step != null && stepEstimate != null) trip.addStep(step.toStep(carContext), stepEstimate)
            }
            if (n.currentRoad.isNotEmpty()) trip.setCurrentRoad(n.currentRoad)
            manager.updateTrip(trip.build())
        } catch (e: RuntimeException) {
            Log.w(TAG, "trip update refused", e)
        }
    }

    companion object {
        const val OFFLINE = "OFFLINE"
        const val TIMEOUT = "TIMEOUT"
        private const val MAX_RECENTS = 5
        private const val MAX_RESULTS = 12
        private const val MAX_ROUTES = 3
        private const val SEARCH_TIMEOUT_MS = 12_000L
        private const val ROUTE_TIMEOUT_MS = 30_000L
        private const val RESUME_TRIES = 8
        private const val RESUME_RETRY_MS = 3_000L
        private const val ARRIVED_END_MS = 45_000L
    }
}

private const val TAG = "ArgusCar"
