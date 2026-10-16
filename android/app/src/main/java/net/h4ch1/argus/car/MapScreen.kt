package net.h4ch1.argus.car

import android.util.Log
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarColor
import androidx.car.app.model.CarIcon
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.car.app.model.Toggle
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.versioning.CarAppApiLevels
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import net.h4ch1.argus.Ink
import net.h4ch1.argus.Prefs
import net.h4ch1.argus.R

/**
 * The car-safe layers offered in the car, by group (TRAFFIC, CAMERAS,
 * AIRCRAFT, WEATHER, PLACES: each a short list, so every layer fits on any
 * host), each with its ctOS map glyph, and the one-tap presets. The page
 * shows the phone's layers within this set and reports which this build can
 * show (a keyed layer only once the phone's proxy has its key), which are on,
 * and the map icons' size; the lists offer those and switch them through the
 * page, which writes the set the phone shares. shell-car/model.js
 * CAR_LAYER_KEYS mirrors the keys in this order (its test reads this list).
 */
object CarLayers {
    enum class Group(@StringRes val title: Int, @DrawableRes val icon: Int) {
        TRAFFIC(R.string.car_group_traffic, R.drawable.ic_layer_traffic),
        CAMERAS(R.string.car_group_cameras, R.drawable.ic_layer_cameras),
        AIRCRAFT(R.string.car_group_aircraft, R.drawable.ic_layer_flights),
        WEATHER(R.string.car_group_weather, R.drawable.ic_layer_radar),
        PLACES(R.string.car_group_places, R.drawable.ic_layer_places),
    }

    data class Layer(val key: String, val group: Group, @StringRes val title: Int, @DrawableRes val icon: Int)

    data class Preset(@StringRes val title: Int, @DrawableRes val icon: Int, val keys: Set<String>)

    val ALL = listOf(
        Layer("incidents", Group.TRAFFIC, R.string.layer_incidents, R.drawable.ic_layer_incidents),
        Layer("chp", Group.TRAFFIC, R.string.layer_chp, R.drawable.ic_layer_chp),
        Layer("waze", Group.TRAFFIC, R.string.layer_waze, R.drawable.ic_layer_waze),
        Layer("trafficflow", Group.TRAFFIC, R.string.layer_trafficflow, R.drawable.ic_layer_flow),
        Layer("simtraffic", Group.TRAFFIC, R.string.layer_simtraffic, R.drawable.ic_layer_traffic),
        Layer("signals", Group.TRAFFIC, R.string.layer_signals, R.drawable.ic_layer_signals),
        Layer("trafficcams", Group.CAMERAS, R.string.layer_trafficcams, R.drawable.ic_layer_cameras),
        Layer("webcams", Group.CAMERAS, R.string.layer_webcams, R.drawable.ic_layer_webcams),
        Layer("surveillance", Group.CAMERAS, R.string.layer_surveillance, R.drawable.ic_layer_alpr),
        Layer("flights", Group.AIRCRAFT, R.string.layer_flights, R.drawable.ic_layer_flights),
        Layer("military", Group.AIRCRAFT, R.string.layer_military, R.drawable.ic_layer_military),
        Layer("radar", Group.WEATHER, R.string.layer_radar, R.drawable.ic_layer_radar),
        Layer("lightning", Group.WEATHER, R.string.layer_lightning, R.drawable.ic_layer_lightning),
        Layer("fires", Group.WEATHER, R.string.layer_fires, R.drawable.ic_layer_fires),
        Layer("quakes", Group.WEATHER, R.string.layer_quakes, R.drawable.ic_layer_quakes),
        Layer("myplaces", Group.PLACES, R.string.layer_myplaces, R.drawable.ic_layer_places),
        Layer("landmarks", Group.PLACES, R.string.layer_landmarks, R.drawable.ic_layer_landmarks),
    )

    val PRESETS = listOf(
        Preset(R.string.car_preset_drive, R.drawable.ic_car_drive, Prefs.CAR_DEFAULT_LAYERS),
        Preset(R.string.car_preset_sky, R.drawable.ic_layer_flights, setOf("flights", "military")),
    )

    /** ICON SIZE's choices (%), as the phone's SETTINGS > ICONS (core/ui/iconPrefs.js ICON_SIZES). */
    val ICON_SIZES = listOf(75, 100, 125, 150, 200)

    /** The layers the car page can show; null until it has said. */
    var available: Set<String>? = null
        private set

    /** The layers on in the car (the phone's, within this set); null until the page has said. */
    var on: Set<String>? = null
        private set

    /** The map icons' size (%), shared with the phone; null until the page has said. */
    var iconSize: Int? = null
        private set
    private val listeners = mutableSetOf<() -> Unit>()

    fun setState(available: Set<String>, on: Set<String>, iconSize: Int?) {
        val size = iconSize?.takeIf { it in ICON_SIZES } ?: this.iconSize
        if (available == this.available && on == this.on && size == this.iconSize) return
        this.available = available
        this.on = on
        this.iconSize = size
        changed()
    }

    /** A switch pressed in the car: shown at once, the page's report confirms it. */
    fun setOn(keys: Set<String>) {
        if (keys == on) return
        on = keys
        changed()
    }

    /** ICON SIZE pressed in the car: shown at once, the page's report confirms it. */
    fun setIconSize(pct: Int) {
        if (pct == iconSize || pct !in ICON_SIZES) return
        iconSize = pct
        changed()
    }

    private fun changed() = listeners.toList().forEach { it() }

    fun observe(fn: () -> Unit): () -> Unit {
        listeners += fn
        return { listeners -= fn }
    }
}

internal fun CarContext.icon(@DrawableRes res: Int): CarIcon =
    CarIcon.Builder(IconCompat.createWithResource(this, res)).setTint(CarColor.DEFAULT).build()

/** Follow a CarNav for as long as a screen lives, invalidating it on every change. */
internal fun Screen.invalidateOn(nav: CarNav) {
    lifecycle.addObserver(object : DefaultLifecycleObserver {
        private var stop: (() -> Unit)? = null

        override fun onCreate(owner: LifecycleOwner) {
            stop = nav.observe { invalidate() }
        }

        override fun onDestroy(owner: LifecycleOwner) {
            stop?.invoke()
            stop = null
        }
    })
}

@StringRes
private fun viewTitle(mode: String): Int = when (mode) {
    "north" -> R.string.car_view_north
    "2d" -> R.string.car_view_2d
    else -> R.string.car_view_auto
}

@DrawableRes
private fun viewIcon(mode: String): Int = when (mode) {
    "north" -> R.drawable.ic_car_view_north
    "2d" -> R.drawable.ic_car_view_2d
    else -> R.drawable.ic_car_view_auto
}

/**
 * The map screen: the globe fills the car display (CarMapRenderer), with the
 * map controls in the map action strip (pan, RECENTER, zoom in, zoom out;
 * Android Auto only sends drags while PAN is there), and WHERE TO (END while
 * navigating), LAYERS and the camera (AUTO, 2D or NORTH) in the action strip,
 * each a ctOS glyph with a short title. Android Auto draws these buttons
 * itself (its font, its shapes); the app picks the icons and the words.
 * Navigating, Android Auto draws the routing card from CarNav, on the ctOS
 * panel colour: the next maneuver and the one after, and the remaining
 * distance, time and arrival.
 */
class MapScreen(
    carContext: CarContext,
    private val renderer: CarMapRenderer,
    private val nav: CarNav,
) : Screen(carContext) {
    init {
        invalidateOn(nav)
    }

    // Every press also asks again for location in the foreground
    // (CarMapRenderer.onDriverAction).
    private fun action(@StringRes title: Int, @DrawableRes icon: Int, onClick: () -> Unit): Action =
        Action.Builder()
            .setTitle(carContext.getString(title))
            .setIcon(carContext.icon(icon))
            .setOnClickListener {
                renderer.onDriverAction()
                onClick()
            }
            .build()

    private fun mapAction(@DrawableRes icon: Int, onClick: () -> Unit): Action =
        Action.Builder()
            .setIcon(carContext.icon(icon))
            .setOnClickListener {
                renderer.onDriverAction()
                onClick()
            }
            .build()

    override fun onGetTemplate(): Template {
        val prefs = Prefs(carContext)
        val mapActions = ActionStrip.Builder()
            .addAction(Action.PAN)
            .addAction(mapAction(R.drawable.ic_car_recenter) { renderer.recenter() })
            .addAction(mapAction(R.drawable.ic_car_zoom_in) { renderer.zoom(ZOOM_STEP) })
            .addAction(mapAction(R.drawable.ic_car_zoom_out) { renderer.zoom(1f / ZOOM_STEP) })
            .build()
        val actions = ActionStrip.Builder()
        // WHERE TO opens search; on a route, END takes its place (a new
        // destination starts from the map again).
        if (nav.navigating) {
            // END in red (ctOS: red for stop), as the strip's one primary
            // action; hosts before car API level 4 show it plain.
            val end = Action.Builder()
                .setTitle(carContext.getString(R.string.car_end))
                .setIcon(carContext.icon(R.drawable.ic_car_end))
                .setOnClickListener {
                    renderer.onDriverAction()
                    nav.stop()
                }
            if (carContext.carAppApiLevel >= CarAppApiLevels.LEVEL_4) {
                end.setFlags(Action.FLAG_PRIMARY).setBackgroundColor(CarColor.RED)
            }
            actions.addAction(end.build())
        } else {
            actions.addAction(
                action(R.string.car_where_to, R.drawable.ic_car_search) {
                    screenManager.push(SearchScreen(carContext, nav))
                },
            )
        }
        actions.addAction(
            action(R.string.car_layers, R.drawable.ic_car_layers) {
                screenManager.push(LayersScreen(carContext, renderer))
            },
        )
        // The camera: AUTO (tilted, heading up, zoom by speed and the next
        // turn), 2D (flat, heading up) or NORTH (flat, north up); its title
        // and glyph are the mode it is in, a press moves to the next and
        // follows the vehicle again.
        actions.addAction(
            action(viewTitle(prefs.carView), viewIcon(prefs.carView)) {
                val views = Prefs.CAR_VIEWS
                prefs.carView = views[(views.indexOf(prefs.carView) + 1) % views.size]
                renderer.pushView()
                renderer.recenter()
                invalidate()
            },
        )
        val template = NavigationTemplate.Builder().setActionStrip(actions.build())
        // Map actions need car API level 2; older hosts get the map without them.
        if (carContext.carAppApiLevel >= CarAppApiLevels.LEVEL_2) template.setMapActionStrip(mapActions)
        if (nav.navigating) {
            // The routing card in ctOS ground; the host keeps it legible.
            template.setBackgroundColor(CarColor.createCustom(Ink.PANEL, Ink.PANEL))
            template.setNavigationInfo(nav.navigationInfo())
            nav.info?.takeIf { it.status != "arrived" }?.destinationEstimate()?.let {
                template.setDestinationTravelEstimate(it)
            }
        }
        return template.build()
    }

    private companion object {
        const val ZOOM_STEP = 1.6f
    }
}

/** Follow CarLayers (the page's reports, the car's own presses) for as long as a screen lives. */
private fun Screen.invalidateOnLayers() {
    lifecycle.addObserver(object : DefaultLifecycleObserver {
        private var stop: (() -> Unit)? = null

        override fun onCreate(owner: LifecycleOwner) {
            stop = CarLayers.observe { invalidate() }
        }

        override fun onDestroy(owner: LifecycleOwner) {
            stop?.invoke()
            stop = null
        }
    })
}

/** How many rows the host shows in a list (at least six on every host). */
private fun CarContext.listLimit(): Int {
    if (carAppApiLevel < CarAppApiLevels.LEVEL_2) return FALLBACK_LIST_LIMIT
    return try {
        getCarService(ConstraintManager::class.java).getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
    } catch (e: RuntimeException) {
        Log.w("ArgusCar", "list limit unavailable", e)
        FALLBACK_LIST_LIMIT
    }
}

// Hosts before car API level 2 cannot say; six rows is the usual floor.
private const val FALLBACK_LIST_LIMIT = 6

/**
 * LAYERS: one row per group (TRAFFIC, CAMERAS, AIRCRAFT, WEATHER, PLACES),
 * each saying which of its layers are on, then DISPLAY (SPEED, ICON SIZE,
 * VEHICLE INFO); the presets DRIVE and SKY in the header. Six rows, so the
 * whole list fits on any host, and each group's own list fits too: every
 * layer is two presses away.
 */
class LayersScreen(carContext: CarContext, private val renderer: CarMapRenderer) : Screen(carContext) {
    private val prefs = Prefs(carContext)

    init {
        invalidateOnLayers()
    }

    private fun preset(keys: Set<String>) {
        if (!renderer.applyLayers(keys)) prefs.carLayers = keys
        val car = CarLayers.ALL.map { it.key }.toSet()
        CarLayers.setOn(((CarLayers.on ?: prefs.carLayers) - car) + (keys intersect car))
    }

    private fun browse(@StringRes title: Int, @DrawableRes icon: Int, text: String, open: () -> Screen): Row =
        Row.Builder()
            .setTitle(carContext.getString(title))
            .addText(text)
            .setImage(carContext.icon(icon), Row.IMAGE_TYPE_ICON)
            .setBrowsable(true)
            .setOnClickListener { screenManager.push(open()) }
            .build()

    // setTitle/setHeaderAction work on every host; their Header replacement
    // needs a newer one.
    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val on = CarLayers.on ?: prefs.carLayers
        val available = CarLayers.available
        val list = ItemList.Builder()
        for (group in CarLayers.Group.values()) {
            val layers = CarLayers.ALL.filter { it.group == group }
            val offered = layers.filter { available == null || it.key in available || it.key in on }
            val lit = offered.filter { it.key in on }
            val text = when {
                offered.isEmpty() -> carContext.getString(R.string.car_group_none)
                lit.isEmpty() -> carContext.getString(R.string.car_group_off)
                else -> lit.joinToString(", ") { carContext.getString(it.title) }
            }
            list.addItem(browse(group.title, group.icon, text) { LayerGroupScreen(carContext, renderer, group) })
        }
        val display = listOfNotNull(
            carContext.getString(R.string.car_speedo).takeIf { prefs.carSpeedo },
            "${CarLayers.iconSize ?: 100}%",
            carContext.getString(R.string.car_vehicle_info).takeIf { prefs.carVehicleInfo },
        ).joinToString(" · ")
        list.addItem(browse(R.string.car_group_display, R.drawable.ic_car_display, display) { DisplayScreen(carContext, renderer) })
        // The header holds two actions, one of them titled: DRIVE says what it
        // is, SKY is its aircraft glyph.
        val (drive, sky) = CarLayers.PRESETS
        val presets = ActionStrip.Builder()
            .addAction(
                Action.Builder()
                    .setTitle(carContext.getString(drive.title))
                    .setIcon(carContext.icon(drive.icon))
                    .setOnClickListener { preset(drive.keys) }
                    .build(),
            )
            .addAction(
                Action.Builder()
                    .setIcon(carContext.icon(sky.icon))
                    .setOnClickListener { preset(sky.keys) }
                    .build(),
            )
            .build()
        return ListTemplate.Builder()
            .setTitle(carContext.getString(R.string.car_layers))
            .setHeaderAction(Action.BACK)
            .setActionStrip(presets)
            .setSingleList(list.build())
            .build()
    }
}

/**
 * One group's layers, a switch each with its map glyph. The switches change
 * the layers the phone shares, so the phone opens with them too. A layer this
 * build cannot show (a keyed one before the phone's proxy has its key) is
 * left out; on a host with fewer rows than the group has, those that are on
 * come first (so they can be switched off), and the choice holds while the
 * list is open.
 */
class LayerGroupScreen(
    carContext: CarContext,
    private val renderer: CarMapRenderer,
    private val group: CarLayers.Group,
) : Screen(carContext) {
    private val prefs = Prefs(carContext)
    private var shown: List<CarLayers.Layer>? = null
    private var shownFor: Set<String>? = null

    init {
        invalidateOnLayers()
    }

    private fun onNow(): Set<String> = CarLayers.on ?: prefs.carLayers

    private fun setLayer(key: String, checked: Boolean) {
        renderer.onDriverAction()
        val now = onNow().toMutableSet()
        if (checked) now += key else now -= key
        if (!renderer.toggleLayer(key, checked)) {
            // The page is not up yet: the next start takes it from here.
            prefs.carLayers = now intersect CarLayers.ALL.map { it.key }.toSet()
        }
        CarLayers.setOn(now)
    }

    /** The group's layers to list, in order, within `rows`: those on first when they do not all fit. */
    private fun pick(rows: Int, available: Set<String>?, on: Set<String>): List<CarLayers.Layer> {
        val offered = CarLayers.ALL.filter {
            it.group == group && (available == null || it.key in available || it.key in on)
        }
        if (offered.size <= rows) return offered
        val keep = (offered.filter { it.key in on } + offered.filter { it.key !in on }).take(rows).toSet()
        return offered.filter { it in keep }
    }

    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val on = onNow()
        val available = CarLayers.available
        val layers = shown?.takeIf { shownFor == available }
            ?: pick(carContext.listLimit().coerceAtLeast(1), available, on).also {
                shown = it
                shownFor = available
            }
        val template = ListTemplate.Builder()
            .setTitle(carContext.getString(group.title))
            .setHeaderAction(Action.BACK)
        if (layers.isEmpty()) {
            // Nothing in this group on this phone yet (a keyed layer waits
            // for its key in the phone's SETUP).
            return template.setSingleList(
                ItemList.Builder().setNoItemsMessage(carContext.getString(R.string.car_group_none)).build(),
            ).build()
        }
        val list = ItemList.Builder()
        for (layer in layers) {
            val toggle = Toggle.Builder { checked -> setLayer(layer.key, checked) }
                .setChecked(layer.key in on)
                .build()
            list.addItem(
                Row.Builder()
                    .setTitle(carContext.getString(layer.title))
                    .setImage(carContext.icon(layer.icon), Row.IMAGE_TYPE_ICON)
                    .setToggle(toggle)
                    .build(),
            )
        }
        return template.setSingleList(list.build()).build()
    }
}

/**
 * DISPLAY: SPEED (the small speed readout on the map), ICON SIZE (every map
 * icon, the same setting as the phone's SETTINGS > ICONS; a press steps
 * through 75 to 200 %) and VEHICLE INFO (the small fuel and range strip while
 * parked).
 */
class DisplayScreen(carContext: CarContext, private val renderer: CarMapRenderer) : Screen(carContext) {
    private val prefs = Prefs(carContext)

    init {
        invalidateOnLayers()
    }

    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val list = ItemList.Builder()
        val speedo = Toggle.Builder { checked ->
            prefs.carSpeedo = checked
            renderer.pushSpeedo()
            invalidate()
        }.setChecked(prefs.carSpeedo).build()
        list.addItem(
            Row.Builder()
                .setTitle(carContext.getString(R.string.car_speedo))
                .setImage(carContext.icon(R.drawable.ic_car_speed), Row.IMAGE_TYPE_ICON)
                .setToggle(speedo)
                .build(),
        )
        val size = CarLayers.iconSize ?: 100
        val sizes = CarLayers.ICON_SIZES
        val next = sizes[(sizes.indexOf(size).coerceAtLeast(0) + 1) % sizes.size]
        list.addItem(
            Row.Builder()
                .setTitle(carContext.getString(R.string.car_icon_size))
                .addText(carContext.getString(R.string.car_icon_size_text, size, next))
                .setImage(carContext.icon(R.drawable.ic_car_icon_size), Row.IMAGE_TYPE_ICON)
                .setOnClickListener {
                    renderer.onDriverAction()
                    renderer.setIconSize(next)
                    CarLayers.setIconSize(next)
                }
                .build(),
        )
        val vehicle = Toggle.Builder { checked ->
            prefs.carVehicleInfo = checked
            renderer.pushVehicleInfo()
            invalidate()
        }.setChecked(prefs.carVehicleInfo).build()
        list.addItem(
            Row.Builder()
                .setTitle(carContext.getString(R.string.car_vehicle_info))
                .setImage(carContext.icon(R.drawable.ic_car_vehicle), Row.IMAGE_TYPE_ICON)
                .setToggle(vehicle)
                .build(),
        )
        return ListTemplate.Builder()
            .setTitle(carContext.getString(R.string.car_group_display))
            .setHeaderAction(Action.BACK)
            .setSingleList(list.build())
            .build()
    }
}
