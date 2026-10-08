package net.h4ch1.argus

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** ctOS palette (core/ui/theme.css). */
object Ink {
    const val GROUND = 0xFF0E0E0E.toInt()
    const val PANEL = 0xFF202020.toInt()
    const val TEXT = Color.WHITE
    const val DIM = 0xFFCACACA.toInt()
    const val SECONDARY = 0xFF7A7A7A.toInt()
    const val ERROR = 0xFFFC3E38.toInt()
}

fun Context.dp(v: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

/** A square ctOS button: white hairline frame, monospace caps. */
fun Context.ctButton(label: String, onClick: () -> Unit): Button =
    Button(this).apply {
        text = label
        isAllCaps = false
        typeface = Typeface.MONOSPACE
        setTextColor(Ink.TEXT)
        textSize = 13f
        letterSpacing = 0.12f
        background = GradientDrawable().apply {
            setColor(Ink.PANEL)
            setStroke(dp(1), Ink.DIM)
        }
        setPadding(dp(16), dp(10), dp(16), dp(10))
        setOnClickListener { onClick() }
    }

/**
 * The native boot screen shown until the proxy answers: the ARGUS lockup on
 * the ctOS ground, a boot-log status line, and on failure the reason with the
 * last lines of the proxy log plus SETTINGS and RESTART.
 */
class SplashView(
    context: Context,
    onSettings: () -> Unit,
    onRestart: () -> Unit,
) : FrameLayout(context) {
    private val status: TextView
    private val error: TextView
    private val errorScroll: ScrollView
    private val actions: LinearLayout

    init {
        setBackgroundColor(Ink.GROUND)
        isClickable = true // swallow touches meant for the page underneath

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(context.dp(24), context.dp(24), context.dp(24), context.dp(24))
        }
        val mark = ImageView(context).apply {
            setImageResource(R.drawable.ic_diamond)
            layoutParams = LinearLayout.LayoutParams(context.dp(44), context.dp(44))
        }
        val title = TextView(context).apply {
            text = context.getString(R.string.app_lockup)
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            setTextColor(Ink.TEXT)
            textSize = 34f
            letterSpacing = 0.35f
            gravity = Gravity.CENTER
            setPadding(0, context.dp(14), 0, 0)
        }
        val rule = View(context).apply {
            setBackgroundColor(Ink.TEXT)
            layoutParams = LinearLayout.LayoutParams(context.dp(132), context.dp(2)).apply {
                topMargin = context.dp(8)
                bottomMargin = context.dp(14)
            }
        }
        status = TextView(context).apply {
            typeface = Typeface.MONOSPACE
            setTextColor(Ink.SECONDARY)
            textSize = 12f
            gravity = Gravity.CENTER
        }
        error = TextView(context).apply {
            typeface = Typeface.MONOSPACE
            setTextColor(Ink.DIM)
            textSize = 11f
            setTextIsSelectable(true)
        }
        errorScroll = ScrollView(context).apply {
            visibility = View.GONE
            addView(error)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                context.dp(220),
            ).apply { topMargin = context.dp(16) }
        }
        actions = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(0, context.dp(16), 0, 0)
            addView(context.ctButton(context.getString(R.string.action_settings), onSettings))
            addView(View(context), LinearLayout.LayoutParams(context.dp(12), 1))
            addView(context.ctButton(context.getString(R.string.action_restart), onRestart))
        }
        column.addView(mark)
        column.addView(title)
        column.addView(rule)
        column.addView(status)
        column.addView(errorScroll)
        column.addView(actions)
        addView(
            column,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER),
        )
        setStep("BOOT")
    }

    fun setStep(step: String) {
        status.setTextColor(Ink.SECONDARY)
        status.text = context.getString(R.string.boot_step, step)
    }

    fun showError(reason: String) {
        alpha = 1f
        visibility = View.VISIBLE
        status.setTextColor(Ink.ERROR)
        status.text = context.getString(R.string.boot_step, "FAILED")
        error.text = reason
        errorScroll.visibility = View.VISIBLE
        actions.visibility = View.VISIBLE
    }

    fun dismiss() {
        if (visibility != View.VISIBLE) return
        animate().alpha(0f).setDuration(260).withEndAction { visibility = View.GONE }.start()
    }
}
