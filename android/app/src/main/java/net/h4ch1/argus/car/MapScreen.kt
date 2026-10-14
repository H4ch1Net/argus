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
 * The car-safe layers offered in the car, in list order (what matters on the
 * road first), each with its ctOS map glyph, and the one-tap presets. The
 * page shows the phone's layers within this set and reports which this build
 * can show (a keyed layer only once the phone's proxy has its key) and which
 * are on; the list offers those and switches them through the page, which
 * writes the set the phone shares. shell-car/model.js CAR_LAYER_KEYS mirrors
 * the keys (its test reads this list).
 */
object CarLayers {
    data class Layer(val key: String, @StringRes val title: Int, @DrawableRes val icon: Int)

    data class Preset(@StringRes val title: Int, @DrawableRes val icon: Int, val keys: Set<String>)

    val ALL = listOf(
        Layer("incidents", R.string.layer_incidents, R.drawable.ic_layer_incidents),
        Layer("chp", R.string.layer_chp, R.drawable.ic_layer_chp),
        Layer("waze", R.string.layer_waze, R.drawable.ic_layer_waze),
        Layer("simtraffic", R.string.layer_simtraffic, R.drawable.ic_layer_traffic),
        Layer("trafficcams", R.string.layer_trafficcams, R.drawable.ic_layer_cameras),
        Layer("surveillance", R.string.layer_surveillance, R.drawable.ic_layer_alpr),
        Layer("signals", R.string.layer_signals, R.drawable.ic_layer_signals),
        Layer("flights", R.string.layer_flights, R.drawable.ic_layer_flights),
        Layer("military", R.string.layer_military, R.drawable.ic_layer_military),
        Layer("radar", R.string.layer_radar, R.drawable.ic_layer_radar),
        Layer("quakes", R.string.layer_quakes, R.drawable.ic_layer_quakes),
    )

    val PRESETS = listOf(
        Preset(R.string.car_preset_drive, R.drawable.ic_car_drive, Prefs.CAR_DEFAULT_LAYERS),
        Preset(R.string.car_preset_sky, R.drawable.ic_layer_flights, setOf("flights", "military")),
    )

    /** The layers the car page can show; null until it has said. */
    var available: Set<String>? = null
        private set

    /** The layers on in the car (the phone's, within this set); null until the page has said. */
    var on: Set<String>? = null
        private set
    private val listeners = mutableSetOf<() -> Unit>()

    fun setState(available: Set<String>, on: Set<String>) {
        if (available == this.available && on == this.on) return
        this.available = available
        this.on = on
        changed()
    }

    /** A switch pressed in the car: shown at once, the page's report confirms it. */
    fun setOn(keys: Set<String>) {
        if (keys == on) return
        on = keys
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
    "2d" -> R.string.car_view_2d
    "north" -> R.string.car_view_north
    else -> R.string.car_view_3d
}

@DrawableRes
private fun viewIcon(mode: String): Int = when (mode) {
    "2d" -> R.drawable.ic_car_view_2d
    "north" -> R.drawable.ic_car_view_north
    else -> R.drawable.ic_car_view_3d
}

/**
 * The map screen: the globe fills the car display (CarMapRenderer), with the
 * map controls in the map action strip (pan, re-centre, zoom in, zoom out),
 * and WHERE TO (END while navigating), LAYERS and VIEW in the action strip,
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

    private fun action(@StringRes title: Int, @DrawableRes icon: Int, onClick: () -> Unit): Action =
        Action.Builder()
            .setTitle(carContext.getString(title))
            .setIcon(carContext.icon(icon))
            .setOnClickListener { onClick() }
            .build()

    private fun mapAction(@DrawableRes icon: Int, onClick: () -> Unit): Action =
        Action.Builder()
            .setIcon(carContext.icon(icon))
            .setOnClickListener { onClick() }
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
                .setOnClickListener { nav.stop() }
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
        // VIEW cycles 3D -> 2D -> NORTH; its title and glyph are the view it is on.
        actions.addAction(
            action(viewTitle(prefs.carView), viewIcon(prefs.carView)) {
                val views = Prefs.CAR_VIEWS
                prefs.carView = views[(views.indexOf(prefs.carView) + 1) % views.size]
                renderer.pushView()
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

/**
 * LAYERS: a switch per layer the page can show, each with its map glyph, and
 * VEHICLE INFO (the small fuel and range strip while parked) last; the presets
 * DRIVE and SKY in the header. The switches change the layers the phone
 * shares, so the phone opens with them too. When the host allows fewer rows
 * than there are layers, those that are on come first (so they can be
 * switched off), and the choice holds while the list is open.
 */
class LayersScreen(carContext: CarContext, private val renderer: CarMapRenderer) : Screen(carContext) {
    private val prefs = Prefs(carContext)
    private var shown: List<CarLayers.Layer>? = null
    private var shownFor: Set<String>? = null

    init {
        // The page reports its layers, and confirms each switch, while this
        // list is open.
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

    private fun listLimit(): Int {
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_2) return FALLBACK_LIST_LIMIT
        return try {
            carContext.getCarService(ConstraintManager::class.java)
                .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
        } catch (e: RuntimeException) {
            Log.w("ArgusCar", "list limit unavailable", e)
            FALLBACK_LIST_LIMIT
        }
    }

    private fun onNow(): Set<String> = CarLayers.on ?: prefs.carLayers

    private fun setLayer(key: String, checked: Boolean) {
        val now = onNow().toMutableSet()
        if (checked) now += key else now -= key
        if (!renderer.toggleLayer(key, checked)) {
            // The page is not up yet: the next start takes it from here.
            prefs.carLayers = now intersect CarLayers.ALL.map { it.key }.toSet()
        }
        CarLayers.setOn(now)
    }

    private fun preset(keys: Set<String>) {
        if (!renderer.applyLayers(keys)) prefs.carLayers = keys
        val car = CarLayers.ALL.map { it.key }.toSet()
        CarLayers.setOn((onNow() - car) + (keys intersect car))
    }

    /** The layers to list, in list order, within `rows`: those on first when they do not all fit. */
    private fun pick(rows: Int, available: Set<String>?, on: Set<String>): List<CarLayers.Layer> {
        val offered = CarLayers.ALL.filter { available == null || it.key in available || it.key in on }
        if (offered.size <= rows) return offered
        val keep = (offered.filter { it.key in on } + offered.filter { it.key !in on }).take(rows).toSet()
        return offered.filter { it in keep }
    }

    // setTitle/setHeaderAction work on every host; their Header replacement
    // needs a newer one.
    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val on = onNow()
        val available = CarLayers.available
        // One row stays for VEHICLE INFO.
        val rows = (listLimit() - 1).coerceAtLeast(1)
        val layers = shown?.takeIf { shownFor == available }
            ?: pick(rows, available, on).also {
                shown = it
                shownFor = available
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

    private companion object {
        // Hosts before car API level 2 cannot say; six rows is the usual floor.
        const val FALLBACK_LIST_LIMIT = 6
    }
}
