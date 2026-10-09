package net.h4ch1.argus.car

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.car.app.CarContext
import androidx.car.app.hardware.CarHardwareManager
import androidx.car.app.hardware.common.CarValue
import androidx.car.app.hardware.common.OnCarDataAvailableListener
import androidx.car.app.hardware.info.CarInfo
import androidx.car.app.hardware.info.EnergyLevel
import androidx.car.app.hardware.info.EnergyProfile
import androidx.car.app.hardware.info.Mileage
import androidx.car.app.hardware.info.Model
import androidx.car.app.hardware.info.Speed
import androidx.car.app.versioning.CarAppApiLevels
import androidx.core.content.ContextCompat
import net.h4ch1.argus.Prefs
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToLong

/**
 * The car's own data for the car page's VEHICLE panel (shell-car/vehicle.js):
 * make, model and year, its fuels, fuel and battery level, range, low-fuel
 * warning, odometer and speed, read through the Car App Library's CarInfo
 * (Android Auto with app-projected; car API level 3 and up). Every value may
 * be missing (an older host, a car that does not report it, a permission not
 * granted): only what arrives is sent. Changes go to the page at most once a
 * second, as one JSON object (argusCar.setCarInfo), with the tank size and
 * body chosen in the phone's Settings and the consumption baseline: the fuel
 * level and odometer at the last fill-up seen, kept in Prefs across drives.
 */
class CarStatsFeed(
    private val carContext: CarContext,
    private val onJson: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val prefs = Prefs(carContext)
    private val executor = ContextCompat.getMainExecutor(carContext)
    private var info: CarInfo? = null
    private var lastSentAt = 0L
    private var posted = false

    private var make: String? = null
    private var model: String? = null
    private var year: Int? = null
    private var fuelTypes: List<Int>? = null
    private var fuelPct: Float? = null
    private var batteryPct: Float? = null
    private var rangeM: Float? = null
    private var lowFuel: Boolean? = null
    private var odometerM: Float? = null
    private var speedMps: Float? = null

    private val flush = Runnable {
        posted = false
        send()
    }

    private val onModel = OnCarDataAvailableListener<Model> { m ->
        make = m.manufacturer.ok()
        model = m.name.ok()
        year = m.year.ok()?.takeIf { it in 1900..2200 }
        changed()
    }

    private val onProfile = OnCarDataAvailableListener<EnergyProfile> { p ->
        fuelTypes = p.fuelTypes.ok()
        changed()
    }

    private val onEnergy = OnCarDataAvailableListener<EnergyLevel> { e ->
        fuelPct = e.fuelPercent.ok()?.takeIf { it.isFinite() && it in 0f..100f }
        batteryPct = e.batteryPercent.ok()?.takeIf { it.isFinite() && it in 0f..100f }
        rangeM = e.rangeRemainingMeters.ok()?.takeIf { it.isFinite() && it >= 0f }
        lowFuel = e.energyIsLow.ok()
        changed()
    }

    private val onMileage = OnCarDataAvailableListener<Mileage> { m ->
        odometerM = m.odometerMeters.ok()?.takeIf { it.isFinite() && it >= 0f }
        changed()
    }

    private val onSpeed = OnCarDataAvailableListener<Speed> { s ->
        val raw = s.rawSpeedMetersPerSecond.ok() ?: s.displaySpeedMetersPerSecond.ok()
        // A tenth of a metre a second is all the panel needs (parked or not).
        val next = raw?.takeIf { it.isFinite() }?.let { kotlin.math.abs(it * 10).roundToLong() / 10f }
        if (next != speedMps) {
            speedMps = next
            changed()
        }
    }

    /** Subscribe (car API level 3 and up); safe to call again. */
    fun start() {
        if (info != null) return
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_3) return
        val carInfo = try {
            carContext.getCarService(CarHardwareManager::class.java).carInfo
        } catch (e: RuntimeException) {
            // HostException on a host that cannot, IllegalStateException
            // without app-projected: no car data, nothing else changes.
            Log.w(TAG, "car hardware unavailable", e)
            return
        }
        info = carInfo
        guarded("model") { carInfo.fetchModel(executor, onModel) }
        guarded("energy profile") { carInfo.fetchEnergyProfile(executor, onProfile) }
        guarded("energy level") { carInfo.addEnergyLevelListener(executor, onEnergy) }
        guarded("mileage") { carInfo.addMileageListener(executor, onMileage) }
        guarded("speed") { carInfo.addSpeedListener(executor, onSpeed) }
    }

    fun stop() {
        val carInfo = info ?: return
        info = null
        guarded("energy level") { carInfo.removeEnergyLevelListener(onEnergy) }
        guarded("mileage") { carInfo.removeMileageListener(onMileage) }
        guarded("speed") { carInfo.removeSpeedListener(onSpeed) }
        main.removeCallbacks(flush)
        posted = false
    }

    private inline fun guarded(what: String, block: () -> Unit) {
        try {
            block()
        } catch (e: RuntimeException) {
            Log.w(TAG, "car $what refused", e)
        }
    }

    private fun changed() {
        if (posted) return
        posted = true
        val wait = (lastSentAt + MIN_INTERVAL_MS - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
        main.postDelayed(flush, wait)
    }

    private fun send() {
        if (info == null) return
        lastSentAt = SystemClock.elapsedRealtime()
        trackFillUp()
        val o = JSONObject().put("available", true).put("t", System.currentTimeMillis())
        if (make != null || model != null || year != null) {
            o.put(
                "model",
                JSONObject().putOpt("make", make).putOpt("name", model).putOpt("year", year),
            )
        }
        fuelTypes?.let { types ->
            o.put("energy", JSONObject().put("fuelTypes", JSONArray(types.mapNotNull { FUELS[it] })))
        }
        fuelPct?.let { o.put("fuelPct", it.toDouble()) }
        batteryPct?.let { o.put("batteryPct", it.toDouble()) }
        rangeM?.let { o.put("rangeM", it.toDouble()) }
        lowFuel?.let { o.put("lowFuel", it) }
        odometerM?.let { o.put("odometerM", it.toDouble()) }
        speedMps?.let { o.put("speedMps", it.toDouble()) }
        val basePct = prefs.fuelBaselinePct
        val baseOdo = prefs.fuelBaselineOdoM
        if (basePct >= 0f && baseOdo >= 0L) {
            o.put("economy", JSONObject().put("fuelPctStart", basePct.toDouble()).put("odometerStartM", baseOdo))
        }
        prefs.tankLitres.takeIf { it > 0f && it.isFinite() }?.let { o.put("tankL", it.toDouble()) }
        prefs.vehicleBody.takeIf { it != "auto" }?.let { o.put("body", it) }
        onJson(o.toString())
    }

    // The consumption baseline: reset at a fill-up (the gauge rose), when the
    // odometer went back (another car), or when there is none yet.
    private fun trackFillUp() {
        val fuel = fuelPct ?: return
        val odo = odometerM ?: return
        val basePct = prefs.fuelBaselinePct
        val baseOdo = prefs.fuelBaselineOdoM
        val fresh = basePct < 0f || baseOdo < 0L || odo < baseOdo || fuel > basePct + REFUEL_PCT
        if (fresh) {
            prefs.fuelBaselinePct = fuel
            prefs.fuelBaselineOdoM = odo.toLong()
        }
    }

    private companion object {
        const val TAG = "ArgusCar"
        const val MIN_INTERVAL_MS = 1000L
        const val REFUEL_PCT = 2f

        // EnergyProfile.FUEL_TYPE_* as the page names them (shell-car/vehicle.js).
        val FUELS = mapOf(
            EnergyProfile.FUEL_TYPE_UNLEADED to "unleaded",
            EnergyProfile.FUEL_TYPE_LEADED to "leaded",
            EnergyProfile.FUEL_TYPE_DIESEL_1 to "diesel_1",
            EnergyProfile.FUEL_TYPE_DIESEL_2 to "diesel_2",
            EnergyProfile.FUEL_TYPE_BIODIESEL to "biodiesel",
            EnergyProfile.FUEL_TYPE_E85 to "e85",
            EnergyProfile.FUEL_TYPE_LPG to "lpg",
            EnergyProfile.FUEL_TYPE_CNG to "cng",
            EnergyProfile.FUEL_TYPE_LNG to "lng",
            EnergyProfile.FUEL_TYPE_ELECTRIC to "electric",
            EnergyProfile.FUEL_TYPE_HYDROGEN to "hydrogen",
            EnergyProfile.FUEL_TYPE_OTHER to "other",
        )

        /** The value when the car reported one, else null (UNKNOWN, UNAVAILABLE, UNIMPLEMENTED). */
        fun <T> CarValue<T>.ok(): T? = if (status == CarValue.STATUS_SUCCESS) value else null
    }
}
