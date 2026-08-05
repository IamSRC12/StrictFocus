package com.strictfocus.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * BootReceiver — restarts the VPN service if a session was active when the device rebooted.
 *
 * On reboot, the elapsedRealtime() counter resets to 0. SessionManager.init() handles this
 * by detecting that the stored elapsed anchor is invalid (remaining time would be enormous)
 * and ends the session gracefully. This is intentional — rebooting is a valid bypass
 * attempt for a truly strict app, but it's acceptable behavior (the user can't use the
 * device while it reboots, so they're not gaining productive time).
 *
 * If the session time has NOT expired (e.g., extremely short reboot), this restores it.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        // Re-initialize session state from SharedPreferences
        SessionManager.init(context)

        if (SessionManager.isSessionActive()) {
            // Session survived reboot (elapsedRealtime restored) — restart VPN
            val vpnIntent = Intent(context, FocusVpnService::class.java).apply {
                action = FocusVpnService.ACTION_START
            }
            context.startForegroundService(vpnIntent)
        }
    }
}
