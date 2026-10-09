package net.h4ch1.argus.car

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
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
    override fun onCreateScreen(intent: Intent): Screen {
        val renderer = CarMapRenderer(carContext, lifecycle)
        val nav = CarNav(carContext, renderer, lifecycle)
        renderer.pageListener = nav
        askPermissions(renderer)
        return MapScreen(carContext, renderer, nav)
    }

    // One prompt on the phone ("check your phone" in the car) for what is
    // missing: location every time it is missing, the car's data (fuel,
    // odometer, speed for the VEHICLE panel) once, where the host can read it.
    private fun askPermissions(renderer: CarMapRenderer) {
        val missing = { p: String -> carContext.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED }
        val wanted = mutableListOf<String>()
        if (missing(Manifest.permission.ACCESS_FINE_LOCATION) && missing(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            wanted += listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        }
        val prefs = Prefs(carContext)
        if (!prefs.carDataAsked && carContext.carAppApiLevel >= CarAppApiLevels.LEVEL_3) {
            val car = CAR_DATA_PERMISSIONS.filter(missing)
            if (car.isNotEmpty()) {
                wanted += car
                prefs.carDataAsked = true
            }
        }
        if (wanted.isEmpty()) return
        carContext.requestPermissions(wanted) { granted, _ ->
            if (granted.any { it.startsWith("android.permission.ACCESS_") }) renderer.onLocationPermission()
            if (granted.any { it in CAR_DATA_PERMISSIONS }) renderer.onCarDataPermission()
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
