package com.strictfocus.app

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Singleton that tracks the global session state, accessible from both the VPN service
 * and the UI. Persists state to SharedPreferences so it survives process restarts.
 *
 * KEY DESIGN: Uses SystemClock.elapsedRealtime() anchors so the user cannot cheat
 * by changing the device's wall clock.
 */
object SessionManager {

    private const val PREFS_NAME = "strict_focus_session"
    private const val KEY_SESSION_ACTIVE = "session_active"
    private const val KEY_ELAPSED_AT_START = "elapsed_at_start"    // elapsedRealtime() when session started
    private const val KEY_DURATION_MS = "duration_ms"              // total session duration in ms
    private const val KEY_WHITELIST = "whitelist_json"             // comma-separated domains

    // ─── Public reactive state ──────────────────────────────────────────────────

    private val _sessionActive = MutableStateFlow(false)
    val sessionActive: StateFlow<Boolean> = _sessionActive.asStateFlow()

    private val _remainingMs = MutableStateFlow(0L)
    val remainingMs: StateFlow<Long> = _remainingMs.asStateFlow()

    private val _whitelistedDomains = MutableStateFlow<List<String>>(emptyList())
    val whitelistedDomains: StateFlow<List<String>> = _whitelistedDomains.asStateFlow()

    // ─── Internal fields ────────────────────────────────────────────────────────

    private lateinit var prefs: SharedPreferences

    /** elapsedRealtime() at the moment the session was started. */
    private var elapsedAtStart: Long = 0L

    /** Total session duration in milliseconds. */
    private var durationMs: Long = 0L

    // ─── Initialization ─────────────────────────────────────────────────────────

    fun init(context: Context) {
        prefs = context.applicationContext
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        restoreFromPrefs()
    }

    // ─── Session Lifecycle ───────────────────────────────────────────────────────

    /**
     * Starts a new session.
     * @param durationMinutes Duration in minutes.
     * @param domains List of whitelisted base domains (e.g. "pw.live").
     */
    fun startSession(durationMinutes: Int, domains: List<String>) {
        val durationMs = durationMinutes * 60_000L
        val elapsedNow = SystemClock.elapsedRealtime()

        this.elapsedAtStart = elapsedNow
        this.durationMs = durationMs

        prefs.edit()
            .putBoolean(KEY_SESSION_ACTIVE, true)
            .putLong(KEY_ELAPSED_AT_START, elapsedNow)
            .putLong(KEY_DURATION_MS, durationMs)
            .putString(KEY_WHITELIST, domains.joinToString(","))
            .apply()

        _whitelistedDomains.value = domains
        _remainingMs.value = durationMs
        _sessionActive.value = true
    }

    /**
     * Called periodically (e.g., every second) to update remaining time.
     * Returns true if the session just finished.
     */
    fun tick(): Boolean {
        if (!_sessionActive.value) return false

        val elapsed = SystemClock.elapsedRealtime() - elapsedAtStart
        val remaining = (durationMs - elapsed).coerceAtLeast(0L)
        _remainingMs.value = remaining

        if (remaining == 0L) {
            endSession()
            return true
        }
        return false
    }

    /** Forcibly ends the session (only called when timer elapses naturally). */
    fun endSession() {
        _sessionActive.value = false
        _remainingMs.value = 0L
        prefs.edit()
            .putBoolean(KEY_SESSION_ACTIVE, false)
            .apply()
    }

    // ─── Accessors ───────────────────────────────────────────────────────────────

    /** Returns remaining milliseconds computed from elapsedRealtime — tamper-proof. */
    fun getRemainingMs(): Long {
        if (!_sessionActive.value) return 0L
        val elapsed = SystemClock.elapsedRealtime() - elapsedAtStart
        return (durationMs - elapsed).coerceAtLeast(0L)
    }

    fun isSessionActive(): Boolean = _sessionActive.value

    fun getWhitelistedDomains(): List<String> = _whitelistedDomains.value

    // ─── Persistence ─────────────────────────────────────────────────────────────

    private fun restoreFromPrefs() {
        val active = prefs.getBoolean(KEY_SESSION_ACTIVE, false)
        if (!active) {
            _sessionActive.value = false
            return
        }

        elapsedAtStart = prefs.getLong(KEY_ELAPSED_AT_START, 0L)
        durationMs = prefs.getLong(KEY_DURATION_MS, 0L)

        val whitelistStr = prefs.getString(KEY_WHITELIST, "") ?: ""
        val domains = if (whitelistStr.isBlank()) emptyList()
        else whitelistStr.split(",").map { it.trim() }.filter { it.isNotBlank() }

        _whitelistedDomains.value = domains

        // Check if session is still valid after restore
        val elapsed = SystemClock.elapsedRealtime() - elapsedAtStart
        val remaining = durationMs - elapsed

        if (remaining <= 0) {
            // Session expired while app was killed
            endSession()
        } else {
            _remainingMs.value = remaining
            _sessionActive.value = true
        }
    }
}
