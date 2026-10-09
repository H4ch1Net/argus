package net.h4ch1.argus.car

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
 * road first), and the one-tap presets. The page reports which of them this
 * build can show (a keyed layer only once the phone's proxy has its key), and
 * the list offers only those.
 */
object CarLayers {
    data class Layer(val key: String, @StringRes val title: Int)

    data class Preset(@StringRes val title: Int, @StringRes val detail: Int, val keys: Set<String>)

    val ALL = listOf(
        Layer("incidents", R.string.layer_incidents),
        Layer("chp", R.string.layer_chp),
        Layer("trafficcams", R.string.layer_trafficcams),
        Layer("surveillance", R.string.layer_surveillance),
        Layer("signals", R.string.layer_signals),
        Layer("flights", R.string.layer_flights),
        Layer("military", R.string.layer_military),
        Layer("radar", R.string.layer_radar),
        Layer("quakes", R.string.layer_quakes),
    )

    val PRESETS = listOf(
        Preset(R.string.car_preset_drive, R.string.car_preset_drive_detail, Prefs.CAR_DEFAULT_LAYERS),
        Preset(R.string.car_preset_sky, R.string.car_preset_sky_detail, setOf("flights", "military")),
    )

    /** The layers the car page can show; null until it has said. */
    var available: Set<String>? = null
        private set
    private val listeners = mutableSetOf<() -> Unit>()

    fun setAvailable(keys: Set<String>) {
        if (keys == available) return
        available = keys
        listeners.toList().forEach { it() }
    }

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

/**
 * The map screen: the globe fills the car display (CarMapRenderer), with the
 * map controls in the map action strip (pan, re-centre, zoom in, zoom out),
 * and WHERE TO (END while navigating), LAYERS and VIEW in the action strip.
 * Navigating, Android Auto draws the routing card from CarNav: the next
 * maneuver and the one after, and the remaining distance, time and arrival.
 */
class MapScreen(
    carContext: CarContext,
    private val renderer: CarMapRenderer,
    private val nav: CarNav,
) : Screen(carContext) {
    init {
        invalidateOn(nav)
    }

    override fun onGetTemplate(): Template {
        val prefs = Prefs(carContext)
        val mapActions = ActionStrip.Builder()
            .addAction(Action.PAN)
            .addAction(
                Action.Builder()
                    .setIcon(carContext.icon(R.drawable.ic_car_recenter))
                    .setOnClickListener { renderer.recenter() }
                    .build(),
            )
            .addAction(
                Action.Builder()
                    .setIcon(carContext.icon(R.drawable.ic_car_zoom_in))
                    .setOnClickListener { renderer.zoom(ZOOM_STEP) }
                    .build(),
            )
            .addAction(
                Action.Builder()
                    .setIcon(carContext.icon(R.drawable.ic_car_zoom_out))
                    .setOnClickListener { renderer.zoom(1f / ZOOM_STEP) }
                    .build(),
            )
            .build()
        val actions = ActionStrip.Builder()
        // WHERE TO opens search; on a route, END takes its place (a new
        // destination starts from the map again).
        if (nav.navigating) {
            actions.addAction(
                Action.Builder()
                    .setTitle(carContext.getString(R.string.car_end))
                    .setIcon(carContext.icon(R.drawable.ic_car_end))
                    .setOnClickListener { nav.stop() }
                    .build(),
            )
        } else {
            actions.addAction(
                Action.Builder()
                    .setTitle(carContext.getString(R.string.car_where_to))
                    .setIcon(carContext.icon(R.drawable.ic_car_search))
                    .setOnClickListener { screenManager.push(SearchScreen(carContext, nav)) }
                    .build(),
            )
        }
        actions
            .addAction(
                Action.Builder()
                    .setTitle(carContext.getString(R.string.car_layers))
                    .setIcon(carContext.icon(R.drawable.ic_car_layers))
                    .setOnClickListener { screenManager.push(LayersScreen(carContext, renderer)) }
                    .build(),
            )
            // VIEW cycles 3D -> 2D -> NORTH; its title is the view it is on.
            .addAction(
                Action.Builder()
                    .setTitle(carContext.getString(viewTitle(prefs.carView)))
                    .setOnClickListener {
                        val views = Prefs.CAR_VIEWS
                        prefs.carView = views[(views.indexOf(prefs.carView) + 1) % views.size]
                        renderer.pushView()
                        invalidate()
                    }
                    .build(),
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
 * LAYERS: the presets (DRIVE, SKY) first, then a toggle per layer the page can
 * show, within the host's list limit. The choice is remembered for the next drive.
 */
class LayersScreen(carContext: CarContext, private val renderer: CarMapRenderer) : Screen(carContext) {
    init {
        // The page may report its layers while this list is open.
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

    private fun listLimit(): Int =
        if (carContext.carAppApiLevel >= CarAppApiLevels.LEVEL_2) {
            carContext.getCarService(ConstraintManager::class.java)
                .getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST)
        } else {
            FALLBACK_LIST_LIMIT
        }

    private fun choose(prefs: Prefs, keys: Set<String>) {
        prefs.carLayers = keys
        renderer.pushLayers()
        invalidate()
    }

    // setTitle/setHeaderAction work on every host; their Header replacement
    // needs a newer one.
    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val prefs = Prefs(carContext)
        val chosen = prefs.carLayers
        val available = CarLayers.available
        val list = ItemList.Builder()
        val limit = listLimit().coerceAtLeast(CarLayers.PRESETS.size + 1)
        for (preset in CarLayers.PRESETS) {
            list.addItem(
                Row.Builder()
                    .setTitle(carContext.getString(preset.title))
                    .addText(carContext.getString(preset.detail))
                    .setOnClickListener { choose(prefs, preset.keys) }
                    .build(),
            )
        }
        var rows = CarLayers.PRESETS.size
        // Layers this build can show, plus any still switched on (so they can
        // be switched off); all of them until the page has said.
        val offered = CarLayers.ALL.filter { available == null || it.key in available || it.key in chosen }
        for (layer in offered) {
            if (rows >= limit) break
            val toggle = Toggle.Builder { checked ->
                val now = prefs.carLayers.toMutableSet()
                if (checked) now += layer.key else now -= layer.key
                choose(prefs, now)
            }.setChecked(layer.key in chosen).build()
            list.addItem(
                Row.Builder()
                    .setTitle(carContext.getString(layer.title))
                    .setToggle(toggle)
                    .build(),
            )
            rows += 1
        }
        return ListTemplate.Builder()
            .setTitle(carContext.getString(R.string.car_layers))
            .setHeaderAction(Action.BACK)
            .setSingleList(list.build())
            .build()
    }

    private companion object {
        // Hosts before car API level 2 cannot say; six rows is the usual floor.
        const val FALLBACK_LIST_LIMIT = 6
    }
}
