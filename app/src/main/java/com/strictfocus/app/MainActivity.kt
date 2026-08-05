package com.strictfocus.app

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.EaseInOutCubic
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

// ─── Color Palette ──────────────────────────────────────────────────────────────

private val DarkBg       = Color(0xFF0A0E1A)
private val SurfaceDark  = Color(0xFF111827)
private val SurfaceCard  = Color(0xFF1A2235)
private val AccentPurple = Color(0xFF7C3AED)
private val AccentViolet = Color(0xFF6D28D9)
private val AccentCyan   = Color(0xFF06B6D4)
private val AccentGreen  = Color(0xFF10B981)
private val AccentRed    = Color(0xFFEF4444)
private val TextPrimary  = Color(0xFFF8FAFC)
private val TextSecondary= Color(0xFF94A3B8)
private val TextMuted    = Color(0xFF475569)
private val BorderColor  = Color(0xFF1E293B)
private val GlowPurple   = Color(0x337C3AED)
private val GlowCyan     = Color(0x2206B6D4)

// ─── MainActivity ────────────────────────────────────────────────────────────────

class MainActivity : ComponentActivity() {

    companion object {
        private const val VPN_PERMISSION_REQUEST = 100
        private const val DEVICE_ADMIN_REQUEST   = 101
    }

    private var vpnPermissionCallback: (() -> Unit)? = null
    private var adminPermissionCallback: (() -> Unit)? = null

    private val vpnPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            vpnPermissionCallback?.invoke()
        } else {
            Toast.makeText(this, "VPN permission is required to run StrictFocus.", Toast.LENGTH_LONG).show()
        }
        vpnPermissionCallback = null
    }

    private val adminPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            adminPermissionCallback?.invoke()
        }
        adminPermissionCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Initialize session state from persistent storage
        SessionManager.init(applicationContext)
        TimerManager.validateSessionIntegrity()

        setContent {
            StrictFocusTheme {
                StrictFocusApp(
                    onRequestVpnPermission = { callback ->
                        val intent = VpnService.prepare(this)
                        if (intent == null) {
                            // Already granted
                            callback()
                        } else {
                            vpnPermissionCallback = callback
                            vpnPermissionLauncher.launch(intent)
                        }
                    },
                    onRequestAdminPermission = { callback ->
                        if (FocusDeviceAdminReceiver.isAdminActive(this)) {
                            callback()
                        } else {
                            adminPermissionCallback = callback
                            adminPermissionLauncher.launch(
                                FocusDeviceAdminReceiver.buildActivationIntent(this)
                            )
                        }
                    },
                    onRequestAccessibilityPermission = {
                        try {
                            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                        } catch (e: ActivityNotFoundException) {
                            Toast.makeText(this, "Cannot open Accessibility settings.", Toast.LENGTH_SHORT).show()
                        }
                    },
                    onStartVpnService = { domains ->
                        val vpnIntent = Intent(this, FocusVpnService::class.java).apply {
                            action = FocusVpnService.ACTION_START
                        }
                        startForegroundService(vpnIntent)
                    }
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Re-validate session when returning to app (bypass attempt might have occurred)
        SessionManager.init(applicationContext)
        TimerManager.validateSessionIntegrity()
    }
}

// ─── Theme ───────────────────────────────────────────────────────────────────────

@Composable
fun StrictFocusTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = androidx.compose.material3.darkColorScheme(
            primary = AccentPurple,
            secondary = AccentCyan,
            background = DarkBg,
            surface = SurfaceDark,
            onPrimary = TextPrimary,
            onSecondary = TextPrimary,
            onBackground = TextPrimary,
            onSurface = TextPrimary
        ),
        content = content
    )
}

// ─── Root App Composable ─────────────────────────────────────────────────────────

@Composable
fun StrictFocusApp(
    onRequestVpnPermission: (callback: () -> Unit) -> Unit,
    onRequestAdminPermission: (callback: () -> Unit) -> Unit,
    onRequestAccessibilityPermission: () -> Unit,
    onStartVpnService: (domains: List<String>) -> Unit
) {
    val context = LocalContext.current
    val sessionActive by SessionManager.sessionActive.collectAsStateWithLifecycle()
    val remainingMs   by SessionManager.remainingMs.collectAsStateWithLifecycle()
    val snackbarHost  = remember { SnackbarHostState() }
    val scope         = rememberCoroutineScope()

    // Tick the timer while the UI is visible
    LaunchedEffect(sessionActive) {
        if (sessionActive) {
            while (true) {
                val finished = SessionManager.tick()
                if (finished) break
                kotlinx.coroutines.delay(500)
            }
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        containerColor = DarkBg
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.radialGradient(
                        colors = listOf(Color(0x1A7C3AED), DarkBg),
                        radius = 1200f
                    )
                )
        ) {
            AnimatedContent(
                targetState = sessionActive,
                transitionSpec = {
                    (fadeIn(tween(500)) + slideInVertically(tween(500)) { it / 4 })
                        .togetherWith(fadeOut(tween(300)) + slideOutVertically(tween(300)) { -it / 4 })
                },
                label = "screen_transition"
            ) { isActive ->
                if (isActive) {
                    ActiveSessionScreen(
                        remainingMs = remainingMs,
                        modifier = Modifier.padding(padding)
                    )
                } else {
                    SetupScreen(
                        modifier = Modifier.padding(padding),
                        onStartSession = { minutes, domains ->
                            // Step 1: Request VPN permission
                            onRequestVpnPermission {
                                // Step 2: Request Device Admin
                                onRequestAdminPermission {
                                    // Step 3: Check Accessibility Service
                                    val isA11yEnabled = isAccessibilityServiceEnabled(context)
                                    if (!isA11yEnabled) {
                                        scope.launch {
                                            snackbarHost.showSnackbar(
                                                "Please enable the StrictFocus accessibility service in the next screen."
                                            )
                                        }
                                        onRequestAccessibilityPermission()
                                        return@onRequestAdminPermission
                                    }

                                    // Step 4: Start the session
                                    SessionManager.startSession(minutes, domains)
                                    onStartVpnService(domains)
                                }
                            }
                        },
                        onRequestAccessibility = onRequestAccessibilityPermission
                    )
                }
            }
        }
    }
}

// ─── Setup Screen ────────────────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(
    modifier: Modifier = Modifier,
    onStartSession: (minutes: Int, domains: List<String>) -> Unit,
    onRequestAccessibility: () -> Unit
) {
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current

    var timerMinutes  by remember { mutableIntStateOf(25) }
    var domainInput   by remember { mutableStateOf("") }
    val whitelistDomains = remember {
        mutableStateListOf(
            "google.com",
            "googleapis.com",
            "gstatic.com"
        )
    }

    val isAdminActive   = FocusDeviceAdminReceiver.isAdminActive(context)
    val isA11yEnabled   = isAccessibilityServiceEnabled(context)

    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp),
        contentPadding = PaddingValues(vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        // ── Header ────────────────────────────────────────────────────────────
        item {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(modifier = Modifier.height(12.dp))

                // Animated logo
                val infiniteTransition = rememberInfiniteTransition(label = "logo_anim")
                val glowAlpha by infiniteTransition.animateFloat(
                    initialValue = 0.4f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(2000, easing = EaseInOutCubic),
                        repeatMode = RepeatMode.Reverse
                    ),
                    label = "glow_alpha"
                )

                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(90.dp)
                        .background(
                            Brush.radialGradient(
                                listOf(AccentPurple.copy(alpha = glowAlpha * 0.4f), Color.Transparent)
                            ),
                            shape = CircleShape
                        )
                ) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .size(70.dp)
                            .background(
                                Brush.linearGradient(listOf(AccentViolet, AccentCyan)),
                                shape = CircleShape
                            )
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Shield,
                            contentDescription = "StrictFocus",
                            tint = TextPrimary,
                            modifier = Modifier.size(36.dp)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                Text(
                    text = "StrictFocus",
                    style = TextStyle(
                        fontSize = 32.sp,
                        fontWeight = FontWeight.ExtraBold,
                        brush = Brush.linearGradient(listOf(AccentPurple, AccentCyan)),
                        shadow = Shadow(AccentPurple.copy(alpha = 0.5f), Offset(0f, 4f), 12f)
                    )
                )
                Text(
                    text = "Zero-distraction productivity enforcer",
                    color = TextSecondary,
                    fontSize = 14.sp,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }

        // ── Permissions Status ────────────────────────────────────────────────
        item {
            GlassCard {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        "Permissions",
                        color = TextPrimary,
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp
                    )
                    PermissionRow(
                        label = "Device Administrator",
                        description = "Prevents uninstallation",
                        granted = isAdminActive,
                        onClick = null
                    )
                    Divider(color = BorderColor)
                    PermissionRow(
                        label = "Accessibility Service",
                        description = "Blocks VPN settings bypass",
                        granted = isA11yEnabled,
                        onClick = onRequestAccessibility
                    )
                }
            }
        }

        // ── Timer Slider ──────────────────────────────────────────────────────
        item {
            GlassCard {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Filled.Timer,
                                contentDescription = null,
                                tint = AccentCyan,
                                modifier = Modifier.size(20.dp)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                "Session Duration",
                                color = TextPrimary,
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                        }
                        // Time display
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(AccentPurple.copy(alpha = 0.2f))
                                .border(1.dp, AccentPurple.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
                                .padding(horizontal = 12.dp, vertical = 4.dp)
                        ) {
                            Text(
                                text = formatMinutes(timerMinutes),
                                color = AccentPurple,
                                fontWeight = FontWeight.ExtraBold,
                                fontSize = 16.sp
                            )
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                    Slider(
                        value = timerMinutes.toFloat(),
                        onValueChange = { timerMinutes = it.toInt() },
                        valueRange = 1f..480f,
                        steps = 0,
                        colors = SliderDefaults.colors(
                            thumbColor = AccentPurple,
                            activeTrackColor = AccentPurple,
                            inactiveTrackColor = AccentPurple.copy(alpha = 0.2f)
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                    // Quick-select chips
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        listOf(15, 25, 45, 60, 90, 120).forEach { mins ->
                            TimerChip(
                                label = if (mins >= 60) "${mins / 60}h" else "${mins}m",
                                selected = timerMinutes == mins,
                                onClick = { timerMinutes = mins },
                                modifier = Modifier.weight(1f)
                            )
                        }
                    }
                }
            }
        }

        // ── Domain Whitelist ──────────────────────────────────────────────────
        item {
            GlassCard {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.Lock,
                            contentDescription = null,
                            tint = AccentGreen,
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Whitelisted Domains",
                            color = TextPrimary,
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp
                        )
                        Spacer(Modifier.weight(1f))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(6.dp))
                                .background(AccentGreen.copy(alpha = 0.15f))
                                .padding(horizontal = 8.dp, vertical = 2.dp)
                        ) {
                            Text(
                                "${whitelistDomains.size} domains",
                                color = AccentGreen,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Medium
                            )
                        }
                    }

                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Add base domains — all subdomains are automatically included (e.g. add pw.live to allow video.pw.live)",
                        color = TextMuted,
                        fontSize = 12.sp,
                        lineHeight = 16.sp
                    )

                    Spacer(Modifier.height(12.dp))

                    // Add domain input
                    OutlinedTextField(
                        value = domainInput,
                        onValueChange = { domainInput = it.lowercase().trim() },
                        placeholder = {
                            Text("e.g. pw.live, notion.so", color = TextMuted, fontSize = 14.sp)
                        },
                        trailingIcon = {
                            IconButton(
                                onClick = {
                                    addDomain(domainInput, whitelistDomains)
                                    domainInput = ""
                                    focusManager.clearFocus()
                                }
                            ) {
                                Icon(Icons.Filled.Add, "Add domain", tint = AccentCyan)
                            }
                        },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Done
                        ),
                        keyboardActions = KeyboardActions(
                            onDone = {
                                addDomain(domainInput, whitelistDomains)
                                domainInput = ""
                                focusManager.clearFocus()
                            }
                        ),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = AccentCyan,
                            unfocusedBorderColor = BorderColor,
                            focusedTextColor = TextPrimary,
                            unfocusedTextColor = TextPrimary,
                            cursorColor = AccentCyan
                        ),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(Modifier.height(12.dp))

                    // Domain chips
                    if (whitelistDomains.isEmpty()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 16.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "No domains whitelisted.\nAll internet traffic will be blocked.",
                                color = AccentRed.copy(alpha = 0.8f),
                                fontSize = 13.sp,
                                textAlign = TextAlign.Center
                            )
                        }
                    } else {
                        whitelistDomains.forEach { domain ->
                            DomainChip(
                                domain = domain,
                                onRemove = { whitelistDomains.remove(domain) }
                            )
                            Spacer(Modifier.height(6.dp))
                        }
                    }
                }
            }
        }

        // ── Start Button ──────────────────────────────────────────────────────
        item {
            val pulseScale = remember { Animatable(1f) }
            LaunchedEffect(Unit) {
                while (true) {
                    pulseScale.animateTo(1.04f, tween(800, easing = EaseInOutCubic))
                    pulseScale.animateTo(1.00f, tween(800, easing = EaseInOutCubic))
                }
            }

            Button(
                onClick = { onStartSession(timerMinutes, whitelistDomains.toList()) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(60.dp)
                    .scale(pulseScale.value),
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                contentPadding = PaddingValues(0.dp)
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            Brush.linearGradient(listOf(AccentViolet, AccentCyan)),
                            shape = RoundedCornerShape(16.dp)
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            Icons.Filled.PlayArrow,
                            contentDescription = null,
                            tint = TextPrimary,
                            modifier = Modifier.size(24.dp)
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "Start Focus Session",
                            color = TextPrimary,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = 18.sp
                        )
                    }
                }
            }

            Spacer(Modifier.height(4.dp))
            Text(
                "⚠️ Once started, the session cannot be stopped until the timer expires.",
                color = TextMuted,
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

// ─── Active Session Screen ────────────────────────────────────────────────────────

@Composable
fun ActiveSessionScreen(
    remainingMs: Long,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "session_anim")

    val ringAlpha by infiniteTransition.animateFloat(
        initialValue = 0.3f,
        targetValue = 0.8f,
        animationSpec = infiniteRepeatable(
            animation = tween(2500, easing = EaseInOutCubic),
            repeatMode = RepeatMode.Reverse
        ),
        label = "ring_alpha"
    )

    val ringScale by infiniteTransition.animateFloat(
        initialValue = 0.95f,
        targetValue = 1.05f,
        animationSpec = infiniteRepeatable(
            animation = tween(2500, easing = EaseInOutCubic),
            repeatMode = RepeatMode.Reverse
        ),
        label = "ring_scale"
    )

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Top label
        Text(
            "🔒 FOCUS SESSION ACTIVE",
            color = AccentCyan,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 13.sp,
            letterSpacing = 2.sp
        )

        Spacer(Modifier.height(48.dp))

        // Animated ring + timer
        Box(contentAlignment = Alignment.Center) {
            // Outer glow ring
            Box(
                modifier = Modifier
                    .size(260.dp)
                    .scale(ringScale)
                    .background(
                        Brush.radialGradient(
                            listOf(AccentPurple.copy(alpha = ringAlpha * 0.3f), Color.Transparent)
                        ),
                        shape = CircleShape
                    )
            )

            // Progress ring
            CircularProgressIndicator(
                progress = { 1f },
                modifier = Modifier
                    .size(220.dp)
                    .alpha(0.1f),
                color = AccentPurple,
                strokeWidth = 6.dp
            )

            // Remaining time display
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = TimerManager.formatRemainingTime(remainingMs),
                    style = TextStyle(
                        fontSize = 56.sp,
                        fontWeight = FontWeight.ExtraBold,
                        brush = Brush.linearGradient(listOf(TextPrimary, AccentCyan)),
                        shadow = Shadow(AccentPurple.copy(0.7f), Offset(0f, 4f), 20f)
                    )
                )
                Text(
                    "remaining",
                    color = TextSecondary,
                    fontSize = 14.sp
                )
            }
        }

        Spacer(Modifier.height(48.dp))

        // Whitelisted domains display
        val domains = SessionManager.whitelistedDomains.collectAsState()
        if (domains.value.isNotEmpty()) {
            GlassCard {
                Column(
                    modifier = Modifier.padding(16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text(
                        "Allowed Domains",
                        color = TextSecondary,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium
                    )
                    Spacer(Modifier.height(8.dp))
                    domains.value.forEach { domain ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(vertical = 2.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .background(AccentGreen, CircleShape)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                domain,
                                color = AccentGreen,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium
                            )
                            Text(
                                "  + all subdomains",
                                color = TextMuted,
                                fontSize = 11.sp
                            )
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(24.dp))

        // Motivation text
        val motivations = listOf(
            "Stay in the zone. You've got this! 💪",
            "Deep work mode activated. Keep going! 🚀",
            "Every minute counts. Stay focused! ⚡",
            "No distractions. Pure productivity. 🎯"
        )
        val motivationIndex = ((System.currentTimeMillis() / 30_000) % motivations.size).toInt()
        Text(
            motivations[motivationIndex],
            color = TextMuted,
            fontSize = 13.sp,
            textAlign = TextAlign.Center
        )
    }
}

// ─── Reusable Components ─────────────────────────────────────────────────────────

@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = SurfaceCard),
        border = androidx.compose.foundation.BorderStroke(1.dp, BorderColor),
        elevation = CardDefaults.cardElevation(0.dp)
    ) {
        content()
    }
}

@Composable
fun PermissionRow(
    label: String,
    description: String,
    granted: Boolean,
    onClick: (() -> Unit)?
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(label, color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            Text(description, color = TextMuted, fontSize = 12.sp)
        }
        Spacer(Modifier.width(8.dp))
        if (granted) {
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(AccentGreen.copy(alpha = 0.15f))
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            ) {
                Text("✓ Granted", color = AccentGreen, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        } else {
            TextButton(onClick = { onClick?.invoke() }) {
                Text("Grant →", color = AccentCyan, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
fun DomainChip(domain: String, onRemove: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(SurfaceDark)
            .border(1.dp, BorderColor, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(AccentGreen, CircleShape)
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(domain, color = TextPrimary, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Text("*.${domain}  allowed", color = TextMuted, fontSize = 11.sp)
            }
        }
        IconButton(onClick = onRemove, modifier = Modifier.size(32.dp)) {
            Icon(Icons.Filled.Close, "Remove", tint = TextMuted, modifier = Modifier.size(16.dp))
        }
    }
}

@Composable
fun TimerChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) AccentPurple.copy(0.3f) else SurfaceDark)
            .border(
                1.dp,
                if (selected) AccentPurple else BorderColor,
                RoundedCornerShape(8.dp)
            )
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            label,
            color = if (selected) AccentPurple else TextMuted,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal
        )
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────────

private fun formatMinutes(minutes: Int): String {
    return when {
        minutes < 60 -> "${minutes}m"
        minutes % 60 == 0 -> "${minutes / 60}h"
        else -> "${minutes / 60}h ${minutes % 60}m"
    }
}

private fun addDomain(input: String, list: MutableList<String>) {
    val cleaned = input
        .lowercase()
        .removePrefix("https://")
        .removePrefix("http://")
        .removePrefix("www.")
        .split("/").first()
        .trim()

    if (cleaned.isNotBlank() && cleaned.contains('.') && !list.contains(cleaned)) {
        list.add(cleaned)
    }
}

private fun isAccessibilityServiceEnabled(context: Context): Boolean {
    val expectedId = "${context.packageName}/.StrictModeAccessibilityService"
    val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    ) ?: return false
    return enabled.split(':').any { it.equals(expectedId, ignoreCase = true) }
}
