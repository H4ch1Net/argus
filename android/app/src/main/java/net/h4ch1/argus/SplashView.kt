package net.h4ch1.argus

import android.content.Context
import android.graphics.Color
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** ctOS palette (core/ui/theme.css). */
object Ink {
    const val GROUND = 0xFF0E0E0E.toInt()
    const val PANEL = 0xFF202020.toInt()
    const val EDGE = 0xFF414141.toInt()
    const val TEXT = Color.WHITE
    const val DIM = 0xFFCACACA.toInt()
    const val SECONDARY = 0xFF7A7A7A.toInt()
    const val SUCCESS = 0xFF00FA9A.toInt()
    const val ERROR = 0xFFFC3E38.toInt()
}

fun Context.dp(v: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

/**
 * The native boot screen shown until the proxy answers: the ARGUS lockup on
 * the ctOS ground and a boot-log status line; a one-line notice when the app
 * crashed last time (tap: Settings); on failure the reason with the last
 * lines of the proxy log, framed, plus SETTINGS and RESTART.
 */
class SplashView(
    context: Context,
    onSettings: () -> Unit,
    onRestart: () -> Unit,
) : FrameLayout(context) {
    private val status: TextView
    private val notice: TextView
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
            ctType(34f, Ink.TEXT, bold = true, tracking = 0.35f)
            gravity = Gravity.CENTER
            setPadding(0, context.dp(14), 0, 0)
        }
        val rule = View(context).apply {
            setBackgroundColor(Ink.TEXT)
            layoutParams = LinearLayout.LayoutParams(context.dp(132), context.dp(2)).apply {
                topMargin = context.dp(10)
                bottomMargin = context.dp(14)
            }
        }
        status = TextView(context).apply {
            ctType(12f, Ink.SECONDARY, tracking = 0.08f)
            gravity = Gravity.CENTER
        }
        notice = TextView(context).apply {
            ctType(11f, Ink.ERROR, tracking = 0.08f)
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            visibility = View.GONE
            setPadding(0, context.dp(10), 0, 0)
            setOnClickListener { onSettings() }
        }
        error = TextView(context).apply {
            ctType(11f, Ink.DIM, tracking = 0f)
            setTextIsSelectable(true)
        }
        errorScroll = ScrollView(context).apply {
            visibility = View.GONE
            background = context.ctFrame()
            setPadding(context.dp(12), context.dp(10), context.dp(12), context.dp(10))
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
        column.addView(notice)
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

    /** One line under the status (the last crash); a tap opens Settings. */
    fun showNotice(text: String) {
        notice.text = text
        notice.visibility = View.VISIBLE
    }

    fun showError(reason: String) {
        animate().cancel()
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
