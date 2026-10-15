package net.h4ch1.argus.car

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import net.h4ch1.argus.Ink
import net.h4ch1.argus.MainActivity
import net.h4ch1.argus.R

/**
 * Keeps the phone's location flowing to the car map. While the app runs on the
 * car display Android does not count it as in front, so on a locked phone a
 * plain location request gets the last known fix and nothing more (the arrow
 * stands still while the car drives). A foreground service of type location,
 * in the same process as the CarAppService (as the Car App Library
 * recommends), gives the process location access for as long as the car map
 * runs; CarLocationFeed keeps reading the fixes. Its only face is a quiet
 * notification (ARGUS : CAR MAP, using location); no background location
 * permission is asked for.
 *
 * The car session binds it when the map first shows and unbinds it when the
 * session ends, as the Car App Library's navigation sample does: a bound
 * service is never refused for starting in the background, and it goes to the
 * foreground itself (promote). If Android refuses that, the service stays an
 * ordinary bound one and the map runs as before, on whatever fixes the phone
 * still hands out; nothing throws.
 */
class CarLocationService : Service() {
    private val binder = Link()
    private var foreground = false

    /** What the car session holds: promote() once the location permission arrives. */
    inner class Link : Binder() {
        fun promote(): Boolean = this@CarLocationService.promote()
    }

    override fun onBind(intent: Intent?): IBinder {
        promote()
        return binder
    }

    override fun onDestroy() {
        if (foreground) {
            try {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            } catch (e: RuntimeException) {
                Log.w(TAG, "car location service: stopForeground failed", e)
            }
            foreground = false
        }
        super.onDestroy()
    }

    // Each outcome goes to CarGpsLog (Settings, CAR GPS), so a drive leaves a
    // record of whether Android let the service hold location.
    private fun promote(): Boolean {
        if (foreground) return true
        if (!hasLocation(this)) {
            CarGpsLog.foreground("NO LOCATION PERMISSION")
            return false
        }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        } else {
            0
        }
        return try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this), type)
            foreground = true
            CarGpsLog.foreground("ON")
            CarGpsLog.save(this)
            true
        } catch (e: RuntimeException) {
            // ForegroundServiceStartNotAllowedException (Android 12+, no
            // exemption at the time), SecurityException (the location
            // permission or the foreground type refused), and the like.
            Log.w(TAG, "car location service could not go to the foreground", e)
            CarGpsLog.foreground("REFUSED: ${e.javaClass.simpleName}")
            CarGpsLog.save(this)
            false
        }
    }

    /** The session's hold on the service: bind once, promote, unbind at the end. */
    class Handle internal constructor(private val app: Context) : ServiceConnection {
        private var link: Link? = null
        private var bound = false
        private var wantPromote = false

        internal fun bind(): Boolean {
            if (bound) return true
            bound = try {
                app.bindService(Intent(app, CarLocationService::class.java), this, Context.BIND_AUTO_CREATE)
            } catch (e: RuntimeException) {
                Log.w(TAG, "car location service could not be bound", e)
                false
            }
            return bound
        }

        /** Ask again (the location permission was just granted). */
        fun promote() {
            val l = link
            if (l == null) wantPromote = true else l.promote()
        }

        fun release() {
            if (!bound) return
            bound = false
            link = null
            try {
                app.unbindService(this)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "car location service was not bound", e)
            }
        }

        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val l = service as? Link ?: return
            link = l
            if (wantPromote) {
                wantPromote = false
                l.promote()
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            link = null
        }
    }

    companion object {
        private const val TAG = "ArgusCar"
        private const val CHANNEL = "car_location"
        private const val NOTIFICATION_ID = 0x0A12

        /** Bind the service for a car session; null when Android will not. Never throws. */
        fun hold(context: Context): Handle? {
            val handle = Handle(context.applicationContext)
            return if (handle.bind()) handle else null
        }

        private fun notification(context: Context): Notification {
            NotificationManagerCompat.from(context).createNotificationChannel(
                NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_LOW)
                    .setName(context.getString(R.string.car_location_channel))
                    .setShowBadge(false)
                    .build(),
            )
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            return NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_argus)
                .setContentTitle(context.getString(R.string.car_location_title))
                .setContentText(context.getString(R.string.car_location_text))
                .setColor(Ink.PANEL)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(open)
                .build()
        }
    }
}
