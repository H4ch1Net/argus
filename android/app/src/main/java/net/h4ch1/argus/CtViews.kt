package net.h4ch1.argus

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.StateListDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

// The ctOS look for the native screens (Settings, the boot screen), after
// core/ui/theme.css: the dark ground, monospace caps with wide tracking,
// square corners, white corner brackets round framed boxes, hairline rules,
// and green or red only for a state. Android's own widgets (Material switches,
// radio buttons, raised buttons) are not used.

/**
 * Corner brackets round a box (theme.css .ct-frame): white arms at the four
 * corners over an optional fill and hairline edge.
 */
class CornerFrame(
    private val armPx: Float,
    private val strokePx: Float,
    private val ink: Int = Ink.TEXT,
    private val fill: Int = 0,
    private val edge: Int = 0,
) : Drawable() {
    private val arms = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = strokePx
        strokeCap = Paint.Cap.SQUARE
        color = ink
    }
    private val hairline = Paint().apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f
        color = edge
    }
    private val ground = Paint().apply {
        style = Paint.Style.FILL
        color = fill
    }

    override fun draw(canvas: Canvas) {
        val b = bounds
        if (fill != 0) canvas.drawRect(b, ground)
        if (edge != 0) {
            canvas.drawRect(b.left + 0.5f, b.top + 0.5f, b.right - 0.5f, b.bottom - 0.5f, hairline)
        }
        if (armPx <= 0f) return
        val h = strokePx / 2f
        val l = b.left + h
        val t = b.top + h
        val r = b.right - h
        val btm = b.bottom - h
        val a = armPx
        canvas.drawLine(l, t, l + a, t, arms)
        canvas.drawLine(l, t, l, t + a, arms)
        canvas.drawLine(r, t, r - a, t, arms)
        canvas.drawLine(r, t, r, t + a, arms)
        canvas.drawLine(l, btm, l + a, btm, arms)
        canvas.drawLine(l, btm, l, btm - a, arms)
        canvas.drawLine(r, btm, r - a, btm, arms)
        canvas.drawLine(r, btm, r, btm - a, arms)
    }

    override fun setAlpha(alpha: Int) {
        arms.alpha = alpha
        hairline.alpha = alpha
        ground.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        arms.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/** A framed box: brackets, the panel fill and a hairline edge. */
fun Context.ctFrame(): Drawable = CornerFrame(dp(7).toFloat(), dp(1).toFloat() * 1.5f, Ink.TEXT, Ink.PANEL, Ink.EDGE)

/** Monospace caps with ctOS tracking. */
fun TextView.ctType(sizeSp: Float, color: Int, bold: Boolean = false, tracking: Float = 0.12f) {
    typeface = if (bold) Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) else Typeface.MONOSPACE
    textSize = sizeSp
    letterSpacing = tracking
    setTextColor(color)
    includeFontPadding = false
}

/** A section heading: a small white square, the label, a hairline to the edge. */
fun Context.ctHeading(label: String): View =
    LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(22), 0, dp(8))
        addView(View(context).apply { setBackgroundColor(Ink.TEXT) }, LinearLayout.LayoutParams(dp(5), dp(5)))
        addView(
            TextView(context).apply {
                text = label
                ctType(12f, Ink.DIM, tracking = 0.18f)
                setPadding(dp(8), 0, dp(10), 0)
            },
        )
        addView(
            View(context).apply { setBackgroundColor(Ink.EDGE) },
            LinearLayout.LayoutParams(0, dp(1), 1f),
        )
    }

/** A short secondary line (no paragraphs). */
fun Context.ctNote(text: String): TextView =
    TextView(this).apply {
        this.text = text
        ctType(11f, Ink.SECONDARY, tracking = 0.04f)
        setLineSpacing(0f, 1.15f)
        setPadding(0, dp(2), 0, dp(4))
    }

/**
 * An on/off row in ctOS: the label, then a square that fills in white and a
 * state word, green ON or grey OFF. The whole row is the switch.
 */
class CtSwitch(
    context: Context,
    label: String,
    checked: Boolean,
    private val onChange: (Boolean) -> Unit = {},
) : LinearLayout(context) {
    private val box = View(context)
    private val state = TextView(context)

    var isChecked: Boolean = checked
        set(v) {
            if (field == v) return
            field = v
            paint()
            onChange(v)
        }

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = context.dp(44)
        isClickable = true
        isFocusable = true
        background = pressable(context)
        setPadding(context.dp(2), context.dp(6), context.dp(2), context.dp(6))
        addView(
            TextView(context).apply {
                text = label
                ctType(13f, Ink.DIM)
            },
            LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
        )
        addView(box, LayoutParams(context.dp(12), context.dp(12)).apply { marginEnd = context.dp(8) })
        addView(
            state.apply { ctType(12f, Ink.SECONDARY, tracking = 0.16f) },
            LayoutParams(context.dp(34), LayoutParams.WRAP_CONTENT),
        )
        setOnClickListener { isChecked = !isChecked }
        paint()
    }

    private fun paint() {
        box.background = if (isChecked) {
            CornerFrame(0f, 0f, Ink.TEXT, Ink.TEXT, Ink.TEXT)
        } else {
            CornerFrame(0f, 0f, Ink.TEXT, 0, Ink.SECONDARY)
        }
        state.text = if (isChecked) "ON" else "OFF"
        state.setTextColor(if (isChecked) Ink.SUCCESS else Ink.SECONDARY)
        contentDescription = "${(getChildAt(0) as? TextView)?.text}: ${state.text}"
    }
}

/** A row that darkens a touch when pressed, and nothing more. */
private fun pressable(context: Context): Drawable =
    StateListDrawable().apply {
        addState(
            intArrayOf(android.R.attr.state_pressed),
            CornerFrame(0f, 0f, 0, Ink.PANEL, 0),
        )
        addState(intArrayOf(), CornerFrame(0f, 0f, 0, 0, 0))
    }

/** A square ctOS button: monospace caps in corner brackets. */
fun Context.ctButton(label: String, onClick: () -> Unit): Button =
    Button(this).apply {
        text = label
        isAllCaps = false
        ctType(13f, Ink.TEXT, tracking = 0.16f)
        stateListAnimator = null // no Material lift
        minWidth = 0
        minimumWidth = 0
        minHeight = 0
        minimumHeight = dp(40)
        background = StateListDrawable().apply {
            val arm = dp(6).toFloat()
            val stroke = dp(1).toFloat() * 1.5f
            addState(
                intArrayOf(android.R.attr.state_pressed),
                CornerFrame(arm, stroke, Ink.TEXT, Ink.EDGE, Ink.DIM),
            )
            addState(intArrayOf(), CornerFrame(arm, stroke, Ink.TEXT, Ink.PANEL, Ink.EDGE))
        }
        setPadding(dp(16), dp(10), dp(16), dp(10))
        setOnClickListener { onClick() }
    }
