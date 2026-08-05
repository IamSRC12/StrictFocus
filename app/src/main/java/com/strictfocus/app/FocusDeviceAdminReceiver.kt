package com.strictfocus.app

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast

/**
 * FocusDeviceAdminReceiver — prevents the app from being uninstalled while it
 * holds Device Admin privileges.
 *
 * How anti-uninstall works:
 *   1. On first launch, MainActivity prompts the user to grant Device Admin.
 *   2. Once granted, the system prevents uninstalling this app through the
 *      normal UI — it requires the user to first deactivate Device Admin in
 *      Settings > Security > Device Admins.
 *   3. Our AccessibilityService monitors the Device Admin settings screen and
 *      fires GLOBAL_ACTION_BACK if the user tries to deactivate it during a
 *      session.
 *   4. onDisableRequested() is called before admin is removed — we use it to
 *      refuse when a session is active.
 *
 * Additional DeviceAdminReceiver hooks used:
 *   - onEnabled(): Log admin granted, set up any initial policies.
 *   - onDisabled(): Log admin removed (e.g., after session ends).
 *   - onDisableRequested(): Return a message shown to the user asking them to
 *     wait until the session ends. This does NOT block removal (Android doesn't
 *     allow that from this callback alone), but combined with the Accessibility
 *     Service redirect, it prevents removal in practice.
 */
class FocusDeviceAdminReceiver : DeviceAdminReceiver() {

    companion object {
        const val TAG = "FocusDeviceAdmin"

        /**
         * Returns the ComponentName for this DeviceAdminReceiver.
         * Used when requesting admin activation and checking admin status.
         */
        fun getComponentName(context: Context): ComponentName =
            ComponentName(context.applicationContext, FocusDeviceAdminReceiver::class.java)

        /**
         * Returns true if this app is currently an active Device Admin.
         */
        fun isAdminActive(context: Context): Boolean {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            return dpm.isAdminActive(getComponentName(context))
        }

        /**
         * Builds the Intent to launch the Device Admin activation screen.
         * Present this to the user when they try to start a session without admin.
         */
        fun buildActivationIntent(context: Context): Intent {
            return Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                putExtra(
                    DevicePolicyManager.EXTRA_DEVICE_ADMIN,
                    getComponentName(context)
                )
                putExtra(
                    DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "StrictFocus needs Device Administrator access to prevent " +
                    "the app from being uninstalled during a focus session. " +
                    "This ensures your productivity commitment is enforced."
                )
            }
        }
    }

    // ─── Lifecycle Callbacks ─────────────────────────────────────────────────────

    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i(TAG, "Device Admin ENABLED for StrictFocus")
        Toast.makeText(
            context,
            "StrictFocus: Admin access granted. App is now protected.",
            Toast.LENGTH_SHORT
        ).show()
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.i(TAG, "Device Admin DISABLED for StrictFocus")
    }

    /**
     * Called when the user tries to remove Device Admin for this app.
     *
     * Returns a warning message shown in the confirmation dialog.
     * NOTE: Returning a non-null message adds an extra confirmation step,
     * but Android will still allow removal if the user confirms. The
     * AccessibilityService intercept is the primary blocker during sessions.
     */
    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        return if (SessionManager.isSessionActive()) {
            val remainingMs = SessionManager.getRemainingMs()
            val remainingFormatted = TimerManager.formatRemainingTime(remainingMs)
            "⚠️ A focus session is currently active ($remainingFormatted remaining)! " +
            "Removing admin access will not stop the VPN filter. " +
            "Please wait until the session ends."
        } else {
            "Are you sure you want to remove StrictFocus admin access? " +
            "You won't be protected in future sessions until you re-grant it."
        }
    }

    override fun onPasswordChanged(context: Context, intent: Intent) {
        super.onPasswordChanged(context, intent)
        Log.d(TAG, "Password changed")
    }

    override fun onPasswordFailed(context: Context, intent: Intent) {
        super.onPasswordFailed(context, intent)
        Log.d(TAG, "Password failed")
    }

    override fun onPasswordSucceeded(context: Context, intent: Intent) {
        super.onPasswordSucceeded(context, intent)
        Log.d(TAG, "Password succeeded")
    }
}
