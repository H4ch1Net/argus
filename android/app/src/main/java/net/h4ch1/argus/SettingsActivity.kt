package net.h4ch1.argus

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import java.io.IOException
import java.util.Locale
import net.h4ch1.argus.car.CarGpsLog

/**
 * Native settings, in the ctOS look: the keys file the proxy reads
 * (app-private, never backed up, never sent to the page), full screen,
 * sharing the proxy on Wi-Fi, the car's tank size (for the VEHICLE strip's
 * average consumption), the last crash (with COPY) and the proxy log. Saving
 * restarts the app so the proxy reloads its keys. (The globe's own SETUP tab,
 * where present, writes the same keys file.)
 */
class SettingsActivity : Activity() {
    private lateinit var keys: EditText
    private lateinit var lan: CtSwitch
    private lateinit var fullscreen: CtSwitch
    private lateinit var tank: EditText
    private lateinit var tankGallons: CtSwitch

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The keys are on screen in plain text: keep them out of screenshots
        // and the recent-apps thumbnail.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        window.setBackgroundDrawable(ColorDrawable(Ink.GROUND))

        val paths = ArgusPaths(this)
        val prefs = Prefs(this)

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(20), dp(18), dp(36))
        }
        column.addView(header())
        column.addView(
            ctNote(getString(R.string.settings_version, BuildConfig.VERSION_NAME, NodeRuntime.baseUrl() ?: "--")),
        )

        CrashLog.read(this)?.let { column.addCrash(it) }

        column.addView(ctHeading(getString(R.string.settings_keys)))
        column.addView(ctNote(getString(R.string.settings_keys_help)))
        keys = field(readKeys(paths), "OPENSKY_CLIENT_ID=...").apply {
            textSize = 12f
            gravity = Gravity.TOP or Gravity.START
            minLines = 8
            // No suggestions and no learning: these are secrets.
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setHorizontallyScrolling(false)
        }
        column.addView(keys, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(6) })

        column.addView(ctHeading(getString(R.string.settings_display)))
        fullscreen = CtSwitch(this, getString(R.string.settings_fullscreen), prefs.immersive)
        column.addView(fullscreen)

        column.addView(ctHeading(getString(R.string.settings_network)))
        lan = CtSwitch(this, getString(R.string.settings_lan), prefs.lan)
        column.addView(lan)
        column.addView(ctNote(getString(R.string.settings_lan_help)))

        column.addView(ctHeading(getString(R.string.settings_vehicle)))
        tank = field(tankText(prefs), getString(R.string.settings_tank_hint)).apply {
            textSize = 14f
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
        }
        column.addView(
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(
                    TextView(context).apply {
                        text = getString(R.string.settings_tank)
                        ctType(13f, Ink.DIM)
                    },
                    LinearLayout.LayoutParams(0, WRAP, 1f),
                )
                addView(tank, LinearLayout.LayoutParams(dp(110), WRAP))
            },
        )
        tankGallons = CtSwitch(this, getString(R.string.settings_tank_gallons), prefs.tankGallons) onChange@{ gallons ->
            // Switching the unit converts what is typed.
            val v = parseTank() ?: return@onChange
            tank.setText(formatTank(if (gallons) v / LITRES_PER_GALLON else v * LITRES_PER_GALLON))
        }
        column.addView(tankGallons)
        column.addView(ctNote(getString(R.string.settings_tank_help)))

        column.addView(
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(22), 0, dp(4))
                addView(ctButton(getString(R.string.action_save_restart)) { save(paths, prefs) })
                addView(View(context), LinearLayout.LayoutParams(dp(12), 1))
                addView(ctButton(getString(R.string.action_cancel)) { finish() })
            },
        )

        // The last Android Auto drive: which sources gave the car map its
        // position, and whether the location service reached the foreground.
        CarGpsLog.summary(this)?.let { report ->
            column.addView(ctHeading(getString(R.string.settings_car_gps)))
            column.addView(ctNote(getString(R.string.settings_car_gps_help)))
            column.addView(block(report), LinearLayout.LayoutParams(MATCH, WRAP))
        }

        column.addView(ctHeading(getString(R.string.settings_log)))
        column.addView(
            block(NodeRuntime.tail(paths.logFile, 150).ifEmpty { getString(R.string.settings_log_empty) }),
            LinearLayout.LayoutParams(MATCH, dp(260)),
        )

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(column)
        }
        setContentView(scroll)
        // Edge to edge (Android 15 and later always are): keep the content
        // clear of the status and navigation bars and the keyboard.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    private fun header(): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(4), 0, dp(6))
            addView(
                ImageView(context).apply { setImageResource(R.drawable.ic_diamond) },
                LinearLayout.LayoutParams(dp(22), dp(22)).apply { marginEnd = dp(12) },
            )
            addView(
                TextView(context).apply {
                    text = getString(R.string.settings_title)
                    ctType(18f, Ink.TEXT, bold = true, tracking = 0.16f)
                },
            )
        }

    // The last crash: when, what, the whole trace (scrolls), COPY and CLEAR.
    private fun LinearLayout.addCrash(trace: String) {
        CrashLog.markSeen(this@SettingsActivity)
        addView(ctHeading(getString(R.string.settings_crash)))
        addView(
            TextView(context).apply {
                text = CrashLog.summary(trace)
                ctType(12f, Ink.ERROR, tracking = 0.08f)
                setPadding(0, 0, 0, dp(6))
            },
        )
        addView(block(trace), LinearLayout.LayoutParams(MATCH, dp(220)))
        addView(
            LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(10), 0, 0)
                addView(ctButton(getString(R.string.action_copy)) { copy(trace) })
                addView(View(context), LinearLayout.LayoutParams(dp(12), 1))
                addView(
                    ctButton(getString(R.string.action_clear)) {
                        CrashLog.clear(this@SettingsActivity)
                        recreate()
                    },
                )
            },
        )
    }

    private fun copy(text: String) {
        val clip = getSystemService(ClipboardManager::class.java) ?: return
        clip.setPrimaryClip(ClipData.newPlainText("Argus crash", text))
        // Android 13 and later confirm a copy themselves.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(this, getString(R.string.settings_copied), Toast.LENGTH_SHORT).show()
        }
    }

    /** A framed, scrolling monospace block (a trace, the log), selectable. */
    private fun block(text: String): View =
        ScrollView(this).apply {
            background = ctFrame()
            setPadding(dp(12), dp(10), dp(12), dp(10))
            addView(
                HorizontalScrollView(context).apply {
                    addView(
                        TextView(context).apply {
                            this.text = text
                            ctType(10f, Ink.DIM, tracking = 0f)
                            setTextIsSelectable(true)
                        },
                    )
                },
            )
        }

    /** A ctOS text field: monospace on the panel, in corner brackets. */
    private fun field(value: String, hintText: String): EditText =
        EditText(this).apply {
            setText(value)
            hint = hintText
            ctType(13f, Ink.TEXT, tracking = 0.02f)
            setHintTextColor(Ink.SECONDARY)
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            background = ctFrame()
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }

    /** The keys file, or the documented template on first use. */
    private fun readKeys(paths: ArgusPaths): String {
        try {
            if (paths.keysFile.isFile) return paths.keysFile.readText()
            val extracted = File(paths.project, "env.example")
            if (extracted.isFile) return extracted.readText()
            return assets.open("${NodeProject.ASSET_ROOT}/env.example").bufferedReader().use { it.readText() }
        } catch (_: IOException) {
            return ""
        }
    }

    private fun save(paths: ArgusPaths, prefs: Prefs) {
        try {
            paths.root.mkdirs()
            paths.keysFile.writeText(keys.text.toString().replace("\r\n", "\n"))
            // App-private already; make it owner-only all the same.
            paths.keysFile.setReadable(false, false)
            paths.keysFile.setReadable(true, true)
            paths.keysFile.setWritable(false, false)
            paths.keysFile.setWritable(true, true)
        } catch (e: IOException) {
            Toast.makeText(this, getString(R.string.settings_save_failed, e.message), Toast.LENGTH_LONG).show()
            return
        }
        prefs.immersive = fullscreen.isChecked
        prefs.lan = lan.isChecked
        val size = parseTank()
        prefs.tankGallons = tankGallons.isChecked
        prefs.tankLitres = if (size == null || size <= 0f) {
            0f
        } else {
            (if (tankGallons.isChecked) size * LITRES_PER_GALLON else size).coerceAtMost(MAX_TANK_LITRES)
        }
        NodeRuntime.restartApp(this)
    }

    private fun tankText(prefs: Prefs): String {
        val litres = prefs.tankLitres
        if (litres <= 0f) return ""
        return formatTank(if (prefs.tankGallons) litres / LITRES_PER_GALLON else litres)
    }

    /** The tank size typed, in the unit shown; null when not a number. */
    private fun parseTank(): Float? =
        tank.text.toString().trim().replace(',', '.').toFloatOrNull()?.takeIf { it.isFinite() && it >= 0f }

    private fun formatTank(v: Float): String =
        String.format(Locale.ROOT, "%.1f", v).removeSuffix(".0")

    private companion object {
        const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
        const val LITRES_PER_GALLON = 3.785411784f
        const val MAX_TANK_LITRES = 500f
    }
}
