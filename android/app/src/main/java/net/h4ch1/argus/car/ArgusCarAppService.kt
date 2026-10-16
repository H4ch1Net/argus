package net.h4ch1.argus.car

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.util.Log
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator
import androidx.car.app.versioning.CarAppApiLevels
import net.h4ch1.argus.Prefs

/**
 * Android Auto entry point: a navigation-category car app whose map is the
 * Argus globe (car shell) drawn on the car's surface. Android Auto binds this
 * service when the phone connects to the car.
 */
class ArgusCarAppService : CarAppService() {
    override fun createHostValidator(): HostValidator =
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            // Android Auto and Android Automotive hosts, as published by the
            // Car App Library.
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(): Session = ArgusCarSession()
}

class ArgusCarSession : Session() {
    private var nav: CarNav? = null

    override fun onCreateScreen(intent: Intent): Screen {
        val renderer = CarMapRenderer(carContext, lifecycle)
        val nav = CarNav(carContext, renderer, lifecycle)
        this.nav = nav
        renderer.pageListener = nav
        askPermissions(renderer)
        val map = MapScreen(carContext, renderer, nav)
        // Started by Gemini or Google Assistant ("navigate to ..."): the
        // request waits for the map page, then shows its route.
        nav.onIntent(intent)
        return map
    }

    // A request while Argus already runs in the car.
    override fun onNewIntent(intent: Intent) {
        nav?.onIntent(intent)
    }

    // One prompt on the phone ("check your phone" in the car) for what is
    // missing: location every time it is missing, the car's data (fuel,
    // odometer, speed for the VEHICLE strip) once, where the host can read it.
    private fun askPermissions(renderer: CarMapRenderer) {
        val missing = { p: String -> carContext.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED }
        val wanted = mutableListOf<String>()
        if (missing(Manifest.permission.ACCESS_FINE_LOCATION) && missing(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            wanted += listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        val prefs = Prefs(carContext)
        var askingCarData = false
        if (!prefs.carDataAsked && carContext.carAppApiLevel >= CarAppApiLevels.LEVEL_3) {
            val car = CAR_DATA_PERMISSIONS.filter(missing)
            if (car.isNotEmpty()) {
                wanted += car
                askingCarData = true
            }
        }
        if (wanted.isEmpty()) return
        try {
            carContext.requestPermissions(wanted) { granted, _ ->
                if (granted.any { it.startsWith("android.permission.ACCESS_") }) renderer.onLocationPermission()
                if (granted.any { it in CAR_DATA_PERMISSIONS }) renderer.onCarDataPermission()
            }
            if (askingCarData) prefs.carDataAsked = true
        } catch (e: RuntimeException) {
            // A host or a phone that cannot show the prompt right now (it
            // opens an activity on the phone): the map runs without, and the
            // next drive asks again.
            Log.w("ArgusCar", "permission prompt refused", e)
        }
    }

    private companion object {
        // What Android Auto asks the user for before it hands an app the car's
        // data (Car App Library, CarInfo): fuel and energy (level, range,
        // energy profile), odometer, speed. The model needs
        // android.car.permission.CAR_INFO, which the manifest declares; it is
        // not a runtime permission on a phone.
        val CAR_DATA_PERMISSIONS = listOf(
            "com.google.android.gms.permission.CAR_FUEL",
            "com.google.android.gms.permission.CAR_MILEAGE",
            "com.google.android.gms.permission.CAR_SPEED",
        )
    }
}
