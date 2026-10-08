package net.h4ch1.argus.car

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator

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
        val fine = carContext.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = carContext.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) {
            // Shows "check your phone" in the car and the permission prompt on the phone.
            carContext.requestPermissions(
                listOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
            ) { granted, _ -> if (granted.isNotEmpty()) renderer.onLocationPermission() }
        }
        return MapScreen(carContext, renderer)
    }
}
