package net.h4ch1.argus

import android.app.Activity
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.io.IOException

/**
 * Native settings: the keys file the proxy reads (app-private, never backed
 * up, never sent to the page), sharing the proxy on Wi-Fi, full screen, and
 * the proxy log. Saving restarts the app so the proxy reloads its keys. (The
 * globe's own SETUP tab, where present, writes the same file.)
 */
class SettingsActivity : Activity() {
    private lateinit var keys: EditText
    private lateinit var lan: Switch
    private lateinit var fullscreen: Switch

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
            setPadding(dp(16), dp(24), dp(16), dp(32))
        }
        column.addView(heading(getString(R.string.settings_title), 20f))
        column.addView(note(getString(R.string.settings_version, BuildConfig.VERSION_NAME, NodeRuntime.baseUrl() ?: "-")))

        column.addView(heading(getString(R.string.settings_keys), 14f))
        column.addView(note(getString(R.string.settings_keys_help, paths.keysFile.absolutePath)))
        keys = EditText(this).apply {
            setText(readKeys(paths))
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setTextColor(Ink.TEXT)
            setHintTextColor(Ink.SECONDARY)
            hint = "OPENSKY_CLIENT_ID=..."
            gravity = Gravity.TOP or Gravity.START
            minLines = 10
            // No suggestions and no learning: these are secrets.
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setHorizontallyScrolling(false)
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            background = GradientDrawable().apply {
                setColor(Ink.PANEL)
                setStroke(dp(1), Ink.SECONDARY)
            }
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }
        column.addView(keys, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(8) })

        column.addView(heading(getString(R.string.settings_display), 14f))
        fullscreen = switch(getString(R.string.settings_fullscreen), prefs.immersive)
        column.addView(fullscreen)
        column.addView(heading(getString(R.string.settings_network), 14f))
        lan = switch(getString(R.string.settings_lan), prefs.lan)
        column.addView(lan)
        column.addView(note(getString(R.string.settings_lan_help)))

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(20), 0, dp(8))
            addView(ctButton(getString(R.string.action_save_restart)) { save(paths, prefs) })
            addView(View(context), LinearLayout.LayoutParams(dp(12), 1))
            addView(ctButton(getString(R.string.action_cancel)) { finish() })
        }
        column.addView(actions)

        column.addView(heading(getString(R.string.settings_log), 14f))
        column.addView(
            TextView(this).apply {
                text = NodeRuntime.tail(paths.logFile, 150).ifEmpty { getString(R.string.settings_log_empty) }
                typeface = Typeface.MONOSPACE
                textSize = 10f
                setTextColor(Ink.DIM)
                setTextIsSelectable(true)
            },
        )

        setContentView(ScrollView(this).apply { addView(column) })
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
        NodeRuntime.restartApp(this)
    }

    private fun heading(text: String, size: Float) = TextView(this).apply {
        this.text = text
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        textSize = size
        letterSpacing = 0.12f
        setTextColor(Ink.TEXT)
        setPadding(0, dp(18), 0, dp(4))
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        typeface = Typeface.MONOSPACE
        textSize = 11f
        setTextColor(Ink.SECONDARY)
    }

    private fun switch(label: String, checked: Boolean) = Switch(this).apply {
        text = label
        isChecked = checked
        typeface = Typeface.MONOSPACE
        textSize = 13f
        setTextColor(Ink.DIM)
        setPadding(0, dp(8), 0, dp(8))
    }

    private companion object {
        const val MATCH = LinearLayout.LayoutParams.MATCH_PARENT
        const val WRAP = LinearLayout.LayoutParams.WRAP_CONTENT
    }
}
