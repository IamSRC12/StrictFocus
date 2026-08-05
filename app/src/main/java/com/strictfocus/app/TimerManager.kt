package com.strictfocus.app

import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * TimerManager drives the session countdown tick loop.
 *
 * Anti-cheat design:
 *  - All time calculations use SystemClock.elapsedRealtime(), which is anchored to
 *    device boot time and CANNOT be changed by the user adjusting the clock.
 *  - The elapsed start time is stored in SessionManager and persisted to
 *    SharedPreferences. Even if the process is killed and restarted, the correct
 *    remaining time is restored.
 *  - Even if the user changes the time zone or system clock, elapsedRealtime()
 *    keeps ticking from boot and is unaffected.
 *
 * Usage:
 *   TimerManager.start(scope) { finished -> ... }
 *   TimerManager.stop()
 */
object TimerManager {

    private var tickJob: Job? = null

    /**
     * Starts the tick loop in the given [scope].
     * Calls [onFinished] when the timer expires.
     * Safe to call multiple times — cancels any previous loop first.
     */
    fun start(scope: CoroutineScope, onFinished: () -> Unit) {
        stop()
        tickJob = scope.launch(Dispatchers.Default) {
            while (isActive) {
                val finished = SessionManager.tick()
                if (finished) {
                    onFinished()
                    break
                }
                delay(TICK_INTERVAL_MS)
            }
        }
    }

    /** Stops the tick loop without ending the session. */
    fun stop() {
        tickJob?.cancel()
        tickJob = null
    }

    /**
     * Returns a formatted "MM:SS" or "HH:MM:SS" string from a duration in milliseconds.
     */
    fun formatRemainingTime(ms: Long): String {
        if (ms <= 0) return "00:00"
        val totalSeconds = ms / 1000L
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60
        return if (hours > 0) {
            "%02d:%02d:%02d".format(hours, minutes, seconds)
        } else {
            "%02d:%02d".format(minutes, seconds)
        }
    }

    /**
     * Checks whether the current system elapsed time is consistent with the
     * stored session data. If the device has rebooted since the session started,
     * elapsedRealtime() will have reset, so we detect this and end any stale session.
     */
    fun validateSessionIntegrity() {
        // If the remaining time as computed by elapsedRealtime is 0, end the session.
        if (SessionManager.isSessionActive() && SessionManager.getRemainingMs() <= 0) {
            SessionManager.endSession()
        }
    }

    private const val TICK_INTERVAL_MS = 500L // tick every 500ms for smooth countdown
}
