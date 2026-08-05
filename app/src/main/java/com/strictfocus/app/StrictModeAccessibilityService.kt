package com.strictfocus.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * StrictModeAccessibilityService — Anti-bypass guard.
 *
 * This accessibility service monitors window changes across the entire system.
 * When a focus session is active, it detects if the user navigates to:
 *
 *   1. Android Settings > VPN settings (to disconnect the VPN)
 *   2. App Info for this app (to force-stop or uninstall)
 *   3. Any other Settings screen that could be used to bypass the session
 *
 * When a bypass attempt is detected, it:
 *   a. Fires GLOBAL_ACTION_BACK to return to the previous screen
 *   b. Launches MainActivity to pull the user back into the app
 *
 * Monitored packages & activities:
 *   - com.android.settings (generic Settings app)
 *   - com.android.systemui (notification shade, VPN notification area)
 *   - net.typeblog.socks (third-party VPN managers)
 *   - Specific activity names containing "VpnSettings", "AppInfoDashboard", etc.
 *
 * NOTE: This service requests events from ALL packages (no package filter in the
 * XML config) so it can monitor the Settings app regardless of its package name
 * (which varies by Android vendor).
 */
class StrictModeAccessibilityService : AccessibilityService() {

    companion object {
        const val TAG = "StrictModeA11y"

        // Package names of known Settings apps across Android vendors
        private val SETTINGS_PACKAGES = setOf(
            "com.android.settings",
            "com.samsung.android.settings",
            "com.miui.securitycenter",
            "com.lge.settings",
            "com.oppo.settings",
            "com.oneplus.settings",
            "com.motorola.settings",
            "com.asus.settings"
        )

        // Activity class name fragments that indicate a bypass attempt
        private val BLOCKED_ACTIVITY_FRAGMENTS = listOf(
            "VpnSettings",         // Android VPN settings screen
            "VpnApp",              // VPN app detail
            "AppInfoDashboard",    // App Info (force stop / uninstall)
            "AppInfoBase",
            "InstalledAppDetails",
            "ApplicationsSettings",
            "ManageApplications",
            "RunningServices",     // Running services (to kill our service)
            "DeviceAdminSettings", // Device Admin settings (to remove admin)
            "DeviceAdminAdd",
            "DeviceAdminList",
            "ActiveUnlockSettings",
            "VirtualPrivateNetworkSettings"
        )

        // Notification shade package (SystemUI) — blocked when session is active
        // to prevent the user from tapping the VPN notification disconnect button
        private const val SYSTEM_UI_PACKAGE = "com.android.systemui"
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────────

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "StrictModeAccessibilityService connected")

        // Configure dynamically in code as a fallback (also configured via XML)
        val info = serviceInfo ?: AccessibilityServiceInfo()
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
        info.flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        info.notificationTimeout = 50
        info.packageNames = null // Monitor ALL packages
        serviceInfo = info
    }

    override fun onInterrupt() {
        Log.w(TAG, "AccessibilityService interrupted")
    }

    // ─── Event Handling ──────────────────────────────────────────────────────────

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return

        // Only act during an active session
        if (!SessionManager.isSessionActive()) return

        val eventType = event.eventType
        if (eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return

        val packageName  = event.packageName?.toString() ?: return
        val className    = event.className?.toString() ?: ""

        Log.d(TAG, "Window changed: pkg=$packageName cls=$className")

        // ── Check 1: Settings app with a dangerous screen ─────────────────────
        if (packageName in SETTINGS_PACKAGES) {
            if (isBlockedActivity(className)) {
                Log.w(TAG, "BYPASS DETECTED via Settings: $className — redirecting!")
                blockBypassAttempt()
                return
            }
        }

        // ── Check 2: SystemUI / Notification shade ────────────────────────────
        // Block access to notification shade that shows the VPN disconnect button.
        // We allow other SystemUI interactions (status bar, etc.) but block the
        // full notification panel when a session is active by checking class names.
        if (packageName == SYSTEM_UI_PACKAGE) {
            if (className.contains("NotificationShade") ||
                className.contains("NotificationPanel") ||
                className.contains("QSPanel") ||
                className.contains("QuickSettings")
            ) {
                Log.w(TAG, "BYPASS DETECTED via SystemUI notification panel — redirecting!")
                blockBypassAttempt()
                return
            }
        }

        // ── Check 3: Our own app's info screen in Settings ────────────────────
        // Catch any activity that might be showing App Info for this package.
        // The event's text sometimes contains the app name.
        if (packageName in SETTINGS_PACKAGES) {
            val texts = event.text?.joinToString(" ") ?: ""
            if (texts.contains("StrictFocus", ignoreCase = true) &&
                (className.contains("AppInfo") || className.contains("ApplicationInfo"))
            ) {
                Log.w(TAG, "BYPASS DETECTED via App Info for StrictFocus — redirecting!")
                blockBypassAttempt()
                return
            }
        }
    }

    // ─── Bypass Prevention ────────────────────────────────────────────────────────

    /**
     * Immediately fires GLOBAL_ACTION_BACK and then launches MainActivity.
     * The double action ensures the user is pulled back even from nested screens.
     */
    private fun blockBypassAttempt() {
        // Fire back action immediately
        performGlobalAction(GLOBAL_ACTION_BACK)

        // Also bring our app's MainActivity to the foreground
        val launchIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("from_bypass_block", true)
        }

        // Small delay to let the back action complete before launching
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            startActivity(launchIntent)
        }, 150)
    }

    /**
     * Returns true if [className] matches any known blocked activity pattern.
     */
    private fun isBlockedActivity(className: String): Boolean {
        return BLOCKED_ACTIVITY_FRAGMENTS.any { fragment ->
            className.contains(fragment, ignoreCase = true)
        }
    }
}
