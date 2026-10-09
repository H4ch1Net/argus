package net.h4ch1.argus.car

import android.os.Handler
import android.os.Looper
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import androidx.annotation.StringRes
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.DistanceSpan
import androidx.car.app.model.DurationSpan
import androidx.car.app.model.ForegroundCarColorSpan
import androidx.car.app.model.ItemList
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.RoutePreviewNavigationTemplate
import androidx.car.app.versioning.CarAppApiLevels
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import net.h4ch1.argus.Prefs
import net.h4ch1.argus.R

// A row's second line: the distance (formatted by the host, in the car's
// units) then a detail, "1.2 km · Market St, San Francisco".
internal fun detailLine(distance: CarDistance?, detail: String): CharSequence? {
    if (distance == null) return detail.ifEmpty { null }
    val s = SpannableString(if (detail.isEmpty()) " " else " · $detail")
    s.setSpan(DistanceSpan.create(distance.toDistance()), 0, 1, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    return s
}

// The host's limit for a list of this kind (car API level 2+), within ours.
internal fun CarContext.listLimit(type: Int, fallback: Int, max: Int): Int {
    val limit = if (carAppApiLevel >= CarAppApiLevels.LEVEL_2) {
        getCarService(ConstraintManager::class.java).getContentLimit(type)
    } else {
        fallback
    }
    return limit.coerceIn(1, max)
}

@StringRes
private fun problemText(error: String?, avoidHighways: Boolean): Int = when (error) {
    CarNav.OFFLINE, "NAVIGATION OFFLINE", "STARTING" -> R.string.car_nav_offline
    "NO POSITION" -> R.string.car_no_position
    else -> if (avoidHighways) R.string.car_no_route_hwy else R.string.car_no_route
}

/**
 * WHERE TO: a search bar over the map. Before typing it lists the last five
 * destinations; typing (or voice, when the car allows no keyboard) searches
 * after a short pause, near the vehicle, through the car page's navigator.
 * Each row: the place, its distance, and where it is. A tap previews routes.
 */
class SearchScreen(carContext: CarContext, private val nav: CarNav) : Screen(carContext) {
    private val main = Handler(Looper.getMainLooper())
    private var query = ""
    private var results: List<CarPlace> = emptyList()
    private var error: String? = null
    private var searching = false
    private var asked = 0 // the latest search; older answers are dropped
    private val runSearch = Runnable { search() }

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onDestroy(owner: LifecycleOwner) {
                main.removeCallbacks(runSearch)
                asked += 1
            }
        })
    }

    private val callback = object : SearchTemplate.SearchCallback {
        override fun onSearchTextChanged(searchText: String) {
            query = searchText.trim().take(MAX_QUERY)
            main.removeCallbacks(runSearch)
            if (query.length < MIN_CHARS) {
                asked += 1
                results = emptyList()
                error = null
                searching = false
                invalidate()
                return
            }
            main.postDelayed(runSearch, TYPING_PAUSE_MS)
        }

        override fun onSearchSubmitted(searchText: String) {
            query = searchText.trim().take(MAX_QUERY)
            main.removeCallbacks(runSearch)
            search()
        }
    }

    private fun search() {
        if (query.isEmpty()) return
        asked += 1
        val mine = asked
        searching = true
        invalidate()
        nav.search(query) { r ->
            if (mine != asked) return@search
            searching = false
            results = r.places
            error = r.error
            invalidate()
        }
    }

    override fun onGetTemplate(): Template {
        val typed = query.length >= MIN_CHARS
        val places = if (typed) results else nav.recents()
        val b = SearchTemplate.Builder(callback)
            .setHeaderAction(Action.BACK)
            .setSearchHint(carContext.getString(R.string.car_search_hint))
            // With recent places to tap, the keyboard waits for a tap on the bar.
            .setShowKeyboardByDefault(typed || places.isEmpty())
        if (query.isNotEmpty()) b.setInitialSearchText(query)
        // The first answer pending: the host's spinner (a list may not be set).
        if (typed && searching && results.isEmpty()) return b.setLoading(true).build()
        val limit = carContext.listLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST, FALLBACK_ROWS, MAX_ROWS)
        val list = ItemList.Builder()
        for (p in places.take(limit)) {
            val row = Row.Builder()
                .setTitle(p.name)
                .setImage(carContext.icon(if (typed) R.drawable.ic_car_place else R.drawable.ic_car_recent))
                .setOnClickListener { screenManager.push(RoutePreviewScreen(carContext, nav, p)) }
            detailLine(p.distance, p.detail)?.let { row.addText(it) }
            list.addItem(row.build())
        }
        if (places.isEmpty()) {
            val msg = when {
                !typed -> R.string.car_no_recents
                searching -> R.string.car_searching
                error == CarNav.OFFLINE || error == "NAVIGATION OFFLINE" || error == "STARTING" -> R.string.car_nav_offline
                else -> R.string.car_no_results
            }
            list.setNoItemsMessage(carContext.getString(msg))
        }
        return b.setItemList(list.build()).build()
    }

    private companion object {
        const val MIN_CHARS = 2
        const val MAX_QUERY = 200
        const val TYPING_PAUSE_MS = 450L
        const val FALLBACK_ROWS = 6
        const val MAX_ROWS = 8
    }
}

/**
 * The routes to a place: up to three, fastest first, each with its time,
 * distance, the roads it takes, its traffic delay and traffic lights, drawn
 * on the map by the car page (the selected one in white). AVOID HWY plans
 * again without highways and freeways (remembered); NAVIGATE starts the
 * route and returns to the map, where the routing card takes over.
 */
class RoutePreviewScreen(
    carContext: CarContext,
    private val nav: CarNav,
    private val place: CarPlace,
) : Screen(carContext) {
    private val prefs = Prefs(carContext)
    private var routes: List<CarRoute> = emptyList()
    private var error: String? = null
    private var planning = false
    private var selected = 0
    private var startWhenReady = false
    private var started = false

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) = plan()

            override fun onDestroy(owner: LifecycleOwner) {
                // Back without driving: the page clears the routes off the map.
                if (!started) nav.cancelPreview()
            }
        })
    }

    // Planning again keeps the old routes on screen until the new ones are in
    // (a toggle is a refresh of this list, not a new screen).
    private fun plan() {
        planning = true
        error = null
        nav.preview(place, prefs.carAvoidHighways) { r ->
            planning = false
            routes = r.routes
            error = if (r.routes.isEmpty()) (r.error ?: CarNav.TIMEOUT) else null
            selected = 0
            if (startWhenReady && routes.isNotEmpty()) {
                startWhenReady = false
                go()
            } else {
                startWhenReady = false
                invalidate()
            }
        }
    }

    private fun go() {
        val route = routes.getOrNull(selected) ?: routes.firstOrNull() ?: return
        started = true
        nav.start(place, route.id)
        screenManager.popToRoot()
    }

    private fun avoidAction(): Action =
        Action.Builder()
            .setTitle(carContext.getString(if (prefs.carAvoidHighways) R.string.car_avoid_on else R.string.car_avoid_off))
            .setOnClickListener {
                prefs.carAvoidHighways = !prefs.carAvoidHighways
                plan()
                invalidate()
            }
            .build()

    // setTitle/setHeaderAction work on every host; their Header replacement
    // needs a newer one.
    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        if (routes.isEmpty() && !planning && error != null) return problem()
        val b = RoutePreviewNavigationTemplate.Builder()
            .setTitle(place.name)
            .setHeaderAction(Action.BACK)
            .setActionStrip(ActionStrip.Builder().addAction(avoidAction()).build())
        if (routes.isEmpty()) return b.setLoading(true).build()
        val limit = carContext.listLimit(ConstraintManager.CONTENT_LIMIT_TYPE_ROUTE_LIST, MAX_ROUTES, MAX_ROUTES)
        val shown = routes.take(limit)
        val list = ItemList.Builder()
        shown.forEach { list.addItem(routeRow(it)) }
        list.setSelectedIndex(selected.coerceIn(0, shown.size - 1))
        list.setOnSelectedListener { i ->
            selected = i
            shown.getOrNull(i)?.let { nav.selectRoute(it.id) }
        }
        return b.setItemList(list.build())
            .setNavigateAction(
                Action.Builder()
                    .setTitle(carContext.getString(R.string.car_navigate))
                    .setIcon(carContext.icon(R.drawable.ic_car_navigate))
                    .setOnClickListener { if (planning) startWhenReady = true else go() }
                    .build(),
            )
            .build()
    }

    private fun routeRow(r: CarRoute): Row {
        // The time, formatted by the host ("18 min").
        val title = SpannableString(" ")
        title.setSpan(DurationSpan.create(r.durationS), 0, 1, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        val row = Row.Builder().setTitle(title)
        val via = if (r.summary.isNotEmpty()) carContext.getString(R.string.car_route_via, r.summary) else ""
        detailLine(r.distance, via)?.let { row.addText(it) }
        val notes = SpannableStringBuilder()
        val trafficMin = (r.trafficDelayS / 60).toInt()
        if (trafficMin >= 1) {
            notes.append(carContext.getString(R.string.car_route_traffic, trafficMin))
            if (trafficMin >= HEAVY_TRAFFIC_MIN) {
                notes.setSpan(ForegroundCarColorSpan.create(CarColor.YELLOW), 0, notes.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
            }
        }
        if (r.signals > 0) {
            if (notes.isNotEmpty()) notes.append(" · ")
            notes.append(carContext.getString(R.string.car_route_lights, r.signals))
        }
        if (r.avoidHighways) {
            if (notes.isNotEmpty()) notes.append(" · ")
            notes.append(carContext.getString(R.string.car_route_no_hwy))
        }
        if (notes.isNotEmpty()) row.addText(notes)
        return row.build()
    }

    // No route (or the page not ready): say so, with RETRY, and the highway
    // switch when it is what stands in the way.
    private fun problem(): Template {
        val b = MessageTemplate.Builder(carContext.getString(problemText(error, prefs.carAvoidHighways)))
            .setTitle(place.name)
            .setHeaderAction(Action.BACK)
            .addAction(
                Action.Builder()
                    .setTitle(carContext.getString(R.string.car_retry))
                    .setOnClickListener {
                        plan()
                        invalidate()
                    }
                    .build(),
            )
        if (prefs.carAvoidHighways) b.addAction(avoidAction())
        return b.build()
    }

    private companion object {
        const val MAX_ROUTES = 3
        const val HEAVY_TRAFFIC_MIN = 5
    }
}
