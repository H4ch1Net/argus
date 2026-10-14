package net.h4ch1.argus

import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.File
import java.io.IOException
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.system.exitProcess

/**
 * The app process. Installs the crash recorder before anything else runs, for
 * the phone app and the Android Auto session alike (one process).
 */
class ArgusApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
    }
}

/**
 * The last crash, kept on this phone: when an uncaught exception ends the
 * process, its time, thread, app version, Android version and stack trace go
 * to app-private storage (never sent anywhere), and the system's own handler
 * runs as before (the crash dialog, Android vitals). The next start shows a
 * one-line notice on the boot screen and the whole trace under Settings >
 * LAST CRASH, with COPY. A crash in native code (the Node runtime) ends the
 * process without reaching this handler: `adb logcat -b crash -d` has those.
 */
object CrashLog {
    private const val TAG = "ArgusCrash"
    private const val MAX_CHARS = 48 * 1024

    private fun file(context: Context) = File(File(context.filesDir, "argus"), "last-crash.txt")

    private fun seenFile(context: Context) = File(File(context.filesDir, "argus"), "last-crash.seen")

    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is Recorder) return
        Thread.setDefaultUncaughtExceptionHandler(Recorder(app, previous))
    }

    private class Recorder(
        private val app: Context,
        private val previous: Thread.UncaughtExceptionHandler?,
    ) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(thread: Thread, error: Throwable) {
            try {
                write(app, thread, error)
            } catch (_: Throwable) {
                // Nothing may stop the crash from reaching the system handler.
            }
            if (previous != null) {
                previous.uncaughtException(thread, error)
            } else {
                Process.killProcess(Process.myPid())
                exitProcess(10)
            }
        }
    }

    private fun write(context: Context, thread: Thread, error: Throwable) {
        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.ROOT)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date())
        val text = buildString {
            append("ARGUS CRASH\n")
            append("time: ").append(stamp).append('\n')
            append("thread: ").append(thread.name).append('\n')
            append("app: ").append(BuildConfig.VERSION_NAME)
                .append(" (").append(BuildConfig.VERSION_CODE).append(")\n")
            append("android: ").append(Build.VERSION.RELEASE)
                .append(" (API ").append(Build.VERSION.SDK_INT).append(")\n")
            append("device: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append("\n\n")
            append(trace)
        }.take(MAX_CHARS)
        val out = file(context)
        out.parentFile?.mkdirs()
        out.writeText(text)
        seenFile(context).delete()
    }

    /** The last crash recorded, or null. */
    fun read(context: Context): String? =
        try {
            file(context).takeIf { it.isFile }?.readText()?.ifBlank { null }
        } catch (e: IOException) {
            Log.w(TAG, "could not read the last crash", e)
            null
        }

    /** A crash not yet looked at in Settings (for the boot screen's notice). */
    fun unseen(context: Context): Boolean = file(context).isFile && !seenFile(context).isFile

    fun markSeen(context: Context) {
        try {
            val seen = seenFile(context)
            seen.parentFile?.mkdirs()
            seen.writeText("1")
        } catch (e: IOException) {
            Log.w(TAG, "could not mark the crash seen", e)
        }
    }

    fun clear(context: Context) {
        file(context).delete()
        seenFile(context).delete()
    }

    /** One line for the boot screen: the exception's class and when. */
    fun summary(text: String): String {
        val lines = text.lines()
        val time = lines.firstOrNull { it.startsWith("time: ") }?.removePrefix("time: ").orEmpty()
        // The first line of the trace: "java.lang.IllegalStateException: ...".
        val first = lines.dropWhile { it.isNotBlank() }.firstOrNull { it.isNotBlank() }.orEmpty()
        val name = first.substringBefore(':').substringAfterLast('.').ifBlank { "ERROR" }
        return if (time.isEmpty()) name.uppercase(Locale.ROOT) else "${name.uppercase(Locale.ROOT)} : $time"
    }
}
