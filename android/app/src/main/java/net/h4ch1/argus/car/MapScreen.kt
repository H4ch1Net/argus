package net.h4ch1.argus.car

import androidx.annotation.DrawableRes
import androidx.car.app.CarContext
import androidx.car.app.Screen
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
import androidx.core.graphics.drawable.IconCompat
import net.h4ch1.argus.Prefs
import net.h4ch1.argus.R

/** The car-safe layers offered in the car, in list order. */
object CarLayers {
    data class Layer(val key: String, val title: Int)

    val ALL = listOf(
        Layer("flights", R.string.layer_flights),
        Layer("trafficcams", R.string.layer_trafficcams),
        Layer("radar", R.string.layer_radar),
        Layer("quakes", R.string.layer_quakes),
    )
}

private fun CarContext.icon(@DrawableRes res: Int): CarIcon =
    CarIcon.Builder(IconCompat.createWithResource(this, res)).setTint(CarColor.DEFAULT).build()

/**
 * The map screen: the globe fills the car display (CarMapRenderer), with the
 * map controls in the map action strip (pan, re-centre, zoom in, zoom out) and
 * LAYERS in the action strip. No text entry, no lists over the map.
 */
class MapScreen(carContext: CarContext, private val renderer: CarMapRenderer) : Screen(carContext) {
    override fun onGetTemplate(): Template {
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
            .addAction(
                Action.Builder()
                    .setTitle(carContext.getString(R.string.car_layers))
                    .setIcon(carContext.icon(R.drawable.ic_car_layers))
                    .setOnClickListener { screenManager.push(LayersScreen(carContext, renderer)) }
                    .build(),
            )
            .build()
        return NavigationTemplate.Builder()
            .setActionStrip(actions)
            .setMapActionStrip(mapActions)
            .build()
    }

    private companion object {
        const val ZOOM_STEP = 1.6f
    }
}

/** LAYERS: a short list of toggles; the choice is remembered for the next drive. */
class LayersScreen(carContext: CarContext, private val renderer: CarMapRenderer) : Screen(carContext) {
    // setTitle/setHeaderAction work on every host; their Header replacement
    // needs a newer one.
    @Suppress("DEPRECATION")
    override fun onGetTemplate(): Template {
        val prefs = Prefs(carContext)
        val list = ItemList.Builder()
        for (layer in CarLayers.ALL) {
            val toggle = Toggle.Builder { checked ->
                val now = prefs.carLayers.toMutableSet()
                if (checked) now += layer.key else now -= layer.key
                prefs.carLayers = now
                renderer.pushLayers()
            }.setChecked(layer.key in prefs.carLayers).build()
            list.addItem(
                Row.Builder()
                    .setTitle(carContext.getString(layer.title))
                    .setToggle(toggle)
                    .build(),
            )
        }
        return ListTemplate.Builder()
            .setTitle(carContext.getString(R.string.car_layers))
            .setHeaderAction(Action.BACK)
            .setSingleList(list.build())
            .build()
    }
}
