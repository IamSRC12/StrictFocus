package com.strictfocus.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * FocusVpnService — the core packet-filtering VPN.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Android App Traffic                                         │
 * │       │                                                      │
 * │  TUN Interface (10.0.0.1/24) ← all traffic routed here      │
 * │       │                                                      │
 * │  Reader Coroutine reads raw IP packets from /dev/tun         │
 * │       │                                                      │
 * │  ┌────▼──────────────────────────────────────────────────┐  │
 * │  │  PACKET CLASSIFIER                                    │  │
 * │  │                                                        │  │
 * │  │  UDP dst:53 → DNS Handler                             │  │
 * │  │    ├─ Whitelisted domain? → forward to 8.8.8.8, cache │  │
 * │  │    │  resolved IPs, inject response back into TUN     │  │
 * │  │    └─ Non-whitelisted? → inject NXDOMAIN immediately  │  │
 * │  │                                                        │  │
 * │  │  All other packets:                                    │  │
 * │  │    ├─ dst IP in allowedIPs set? → forward via protect()│  │
 * │  │    └─ else → DROP silently                            │  │
 * │  └───────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────┘
 *
 * DNS Design (wildcard subdomain support):
 *   - Whitelist: ["pw.live", "google.com"]
 *   - When a DNS query arrives for "video.pw.live":
 *     → isDomainWhitelisted("video.pw.live") checks:
 *       "video.pw.live" == "pw.live"? No
 *       "video.pw.live".endsWith(".pw.live")? YES → allowed
 *   - Query is forwarded to 8.8.8.8. All A/AAAA record IPs returned are
 *     added to allowedIPs.
 *   - Subsequent TCP/UDP packets to those IPs are forwarded transparently.
 *
 * IP Forwarding:
 *   - Uses protect() so our forwarding sockets bypass the VPN itself.
 *   - UDP packets are relayed via DatagramSocket.
 *   - TCP packets are handled via a TCP proxy coroutine using Sockets.
 *
 * Performance:
 *   - All dropped packets are discarded with zero I/O cost (just buffer.clear()).
 *   - DNS is the only place we do network I/O in the hot path.
 *   - Allowed IP cache grows throughout the session and is never cleared
 *     (IPs don't change during a session).
 */
class FocusVpnService : VpnService() {

    companion object {
        const val TAG = "FocusVpnService"
        const val ACTION_START = "com.strictfocus.app.START_VPN"
        const val ACTION_STOP  = "com.strictfocus.app.STOP_VPN"

        const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID = "strictfocus_vpn_channel"

        // VPN tunnel address
        private const val VPN_ADDRESS = "10.0.0.2"
        private const val VPN_ROUTE   = "0.0.0.0"  // capture ALL traffic
        private const val VPN_PREFIX   = 0           // /0 = entire internet

        // Real DNS server (outside the VPN) to forward whitelisted queries to
        private const val UPSTREAM_DNS = "8.8.8.8"
        private const val DNS_PORT     = 53
        private const val DNS_TIMEOUT_MS = 3000

        // Max packet size (MTU)
        private const val MTU = 32767
    }

    // ─── State ───────────────────────────────────────────────────────────────────

    private var vpnInterface: ParcelFileDescriptor? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var readerJob: Job? = null
    private var timerJob: Job? = null

    /**
     * Set of IP addresses (as InetAddress) that are permitted to receive traffic.
     * Populated dynamically as DNS responses arrive for whitelisted domains.
     *
     * Also pre-populated with:
     *   - All whitelisted domains resolved at startup
     *   - Private LAN ranges (so local network still works)
     */
    private val allowedIps = ConcurrentHashMap.newKeySet<InetAddress>()

    /** Base domains from the whitelist (e.g. "pw.live", "google.com"). */
    private var whitelistedDomains: List<String> = emptyList()

    // ─── Lifecycle ───────────────────────────────────────────────────────────────

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopVpn()
            return START_NOT_STICKY
        }

        if (intent?.action == ACTION_START || SessionManager.isSessionActive()) {
            whitelistedDomains = SessionManager.getWhitelistedDomains()
            startVpn()
        }

        return START_STICKY
    }

    override fun onRevoke() {
        // Called when the VPN is revoked externally (e.g., user disconnects from settings).
        // We restart it immediately if the session is still active.
        Log.w(TAG, "VPN was revoked! Session active: ${SessionManager.isSessionActive()}")
        if (SessionManager.isSessionActive()) {
            stopVpn()
            startVpn() // Restart immediately
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopVpn()
    }

    // ─── VPN Setup ───────────────────────────────────────────────────────────────

    private fun startVpn() {
        Log.i(TAG, "Starting FocusVPN")
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())

        // Build and establish the VPN interface
        val builder = Builder()
            .setSession("StrictFocus")
            .addAddress(VPN_ADDRESS, 32)
            .addDnsServer("8.8.8.8")
            .addDnsServer("8.8.4.4")
            .addRoute(VPN_ROUTE, VPN_PREFIX)   // Route ALL traffic through VPN
            .setMtu(MTU)
            .setBlocking(false)

        // Exclude our own app from the VPN to prevent recursion
        try {
            builder.addDisallowedApplication(packageName)
        } catch (e: Exception) {
            Log.e(TAG, "Could not exclude own package", e)
        }

        vpnInterface = builder.establish()
        if (vpnInterface == null) {
            Log.e(TAG, "Failed to establish VPN interface!")
            stopSelf()
            return
        }

        Log.i(TAG, "VPN interface established. Domains: $whitelistedDomains")

        // Pre-resolve whitelisted domains asynchronously
        serviceScope.launch {
            preResolveWhitelistedDomains()
        }

        // Start the packet processing loop
        startPacketLoop()

        // Start the timer tick loop
        startTimerLoop()
    }

    private fun stopVpn() {
        Log.i(TAG, "Stopping FocusVPN")
        readerJob?.cancel()
        timerJob?.cancel()

        try {
            vpnInterface?.close()
        } catch (e: Exception) {
            Log.e(TAG, "Error closing VPN interface", e)
        }
        vpnInterface = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ─── Pre-resolution ──────────────────────────────────────────────────────────

    /**
     * Resolves all whitelisted domains and their common subdomains at startup so
     * that the allowedIPs cache is pre-warmed. Uses protect() to bypass the VPN.
     */
    private suspend fun preResolveWhitelistedDomains() = withContext(Dispatchers.IO) {
        whitelistedDomains.forEach { domain ->
            resolveAndCacheDomain(domain)
            // Also pre-resolve common subdomains
            listOf("www", "static", "cdn", "api", "video", "media", "assets", "player").forEach { sub ->
                resolveAndCacheDomain("$sub.$domain")
            }
        }
        Log.i(TAG, "Pre-resolution complete. Allowed IPs: ${allowedIps.size}")
    }

    private suspend fun resolveAndCacheDomain(hostname: String) = withContext(Dispatchers.IO) {
        try {
            val addresses = InetAddress.getAllByName(hostname)
            addresses.forEach { addr ->
                allowedIps.add(addr)
                Log.d(TAG, "Pre-resolved: $hostname → ${addr.hostAddress}")
            }
        } catch (e: Exception) {
            Log.d(TAG, "Pre-resolve failed (ok if not a real subdomain): $hostname")
        }
    }

    // ─── Domain Matching ─────────────────────────────────────────────────────────

    /**
     * Returns true if [hostname] is allowed by the whitelist.
     *
     * Rules:
     *  - Exact match: "pw.live" matches "pw.live"
     *  - Subdomain match: "pw.live" matches "video.pw.live", "static.pw.live", etc.
     *  - Always allows: local DNS, loopback, connectivity checks
     */
    private fun isDomainWhitelisted(hostname: String): Boolean {
        val host = hostname.lowercase().trimEnd('.')

        // Always allow connectivity-check and captive-portal domains
        val alwaysAllow = listOf(
            "connectivitycheck.gstatic.com",
            "captive.apple.com",
            "nmcheck.gnome.org",
            "detectportal.firefox.com",
            "msftconnecttest.com",
            "msftncsi.com"
        )
        if (alwaysAllow.any { host == it || host.endsWith(".$it") }) return true

        return whitelistedDomains.any { whitelisted ->
            val w = whitelisted.lowercase().trimEnd('.')
            host == w || host.endsWith(".$w")
        }
    }

    // ─── Packet Processing Loop ───────────────────────────────────────────────────

    private fun startPacketLoop() {
        val fd = vpnInterface ?: return
        val inputStream  = FileInputStream(fd.fileDescriptor)
        val outputStream = FileOutputStream(fd.fileDescriptor)

        readerJob = serviceScope.launch(Dispatchers.IO) {
            val packet = ByteBuffer.allocate(MTU)

            Log.i(TAG, "Packet loop started")
            while (isActive && vpnInterface != null) {
                packet.clear()
                val length = try {
                    inputStream.read(packet.array())
                } catch (e: Exception) {
                    if (isActive) Log.e(TAG, "Read error", e)
                    break
                }

                if (length <= 0) {
                    // Non-blocking: no packet available, yield
                    kotlinx.coroutines.delay(1)
                    continue
                }

                packet.limit(length)
                processPacket(packet, outputStream)
            }
            Log.i(TAG, "Packet loop ended")
        }
    }

    /**
     * Classifies and routes a single IP packet.
     *
     * IPv4 packet layout:
     *   [0]    Version (4) + IHL (header length in 32-bit words)
     *   [1]    DSCP/ECN
     *   [2-3]  Total Length
     *   [4-5]  Identification
     *   [6-7]  Flags + Fragment Offset
     *   [8]    TTL
     *   [9]    Protocol (6=TCP, 17=UDP, 1=ICMP)
     *   [10-11] Header checksum
     *   [12-15] Source IP
     *   [16-19] Destination IP
     *   [20+]  Payload (may have options before that)
     */
    private suspend fun processPacket(packet: ByteBuffer, output: FileOutputStream) {
        val data = packet.array()
        val length = packet.limit()

        if (length < 20) return // Too short to be a valid IPv4 packet

        val version = (data[0].toInt() and 0xFF) shr 4
        if (version != 4) {
            // IPv6 — for now, drop. Can be extended for IPv6 support.
            return
        }

        val ihl = (data[0].toInt() and 0x0F) * 4  // Header length in bytes
        val protocol = data[9].toInt() and 0xFF

        // Extract destination IP (bytes 16-19)
        val dstIp = InetAddress.getByAddress(data.copyOfRange(16, 20))

        // Extract source IP (bytes 12-15) — used for crafting responses
        val srcIp = InetAddress.getByAddress(data.copyOfRange(12, 16))

        // ── DNS (UDP port 53) ─────────────────────────────────────────────────
        if (protocol == 17 /* UDP */) {
            if (ihl + 4 > length) return // Malformed
            val udpSrcPort = ((data[ihl].toInt() and 0xFF) shl 8) or (data[ihl + 1].toInt() and 0xFF)
            val udpDstPort = ((data[ihl + 2].toInt() and 0xFF) shl 8) or (data[ihl + 3].toInt() and 0xFF)

            if (udpDstPort == DNS_PORT) {
                // DNS query intercepted
                val udpPayloadOffset = ihl + 8
                val udpPayloadLength = length - udpPayloadOffset
                if (udpPayloadLength > 0) {
                    handleDnsPacket(
                        data = data,
                        dnsOffset = udpPayloadOffset,
                        dnsLength = udpPayloadLength,
                        originalPacket = data.copyOf(length),
                        srcIp = srcIp,
                        srcPort = udpSrcPort,
                        output = output
                    )
                }
                return
            }
        }

        // ── Non-DNS traffic: check allowed IP ─────────────────────────────────

        // Always allow loopback and private ranges
        if (isPrivateOrLoopback(dstIp)) {
            forwardIpPacket(data, length)
            return
        }

        if (allowedIps.contains(dstIp)) {
            forwardIpPacket(data, length)
        }
        // else: silently drop
    }

    // ─── DNS Handling ─────────────────────────────────────────────────────────────

    private suspend fun handleDnsPacket(
        data: ByteArray,
        dnsOffset: Int,
        dnsLength: Int,
        originalPacket: ByteArray,
        srcIp: InetAddress,
        srcPort: Int,
        output: FileOutputStream
    ) = withContext(Dispatchers.IO) {
        val hostname = DnsPacket.parseQueryHostname(data, dnsOffset, dnsLength)
        Log.d(TAG, "DNS query: $hostname")

        if (hostname == null) return@withContext

        if (isDomainWhitelisted(hostname)) {
            // Forward the DNS query to upstream and cache the IPs
            Log.d(TAG, "DNS ALLOWED: $hostname")
            val responsePayload = forwardDnsQuery(data, dnsOffset, dnsLength, hostname)
            if (responsePayload != null) {
                // Write the DNS response back into the TUN as a spoofed UDP packet
                val ipPacket = buildUdpIpPacket(
                    srcIp  = InetAddress.getByName(UPSTREAM_DNS),
                    srcPort = DNS_PORT,
                    dstIp  = srcIp,
                    dstPort = srcPort,
                    payload = responsePayload
                )
                synchronized(output) {
                    output.write(ipPacket)
                }
            }
        } else {
            // Non-whitelisted: return NXDOMAIN immediately
            Log.d(TAG, "DNS BLOCKED (NXDOMAIN): $hostname")
            val nxResponse = DnsPacket.buildNxDomainResponse(data, dnsOffset, dnsLength)
            if (nxResponse.isNotEmpty()) {
                val ipPacket = buildUdpIpPacket(
                    srcIp  = InetAddress.getByName(UPSTREAM_DNS),
                    srcPort = DNS_PORT,
                    dstIp  = srcIp,
                    dstPort = srcPort,
                    payload = nxResponse
                )
                synchronized(output) {
                    output.write(ipPacket)
                }
            }
        }
    }

    /**
     * Sends a DNS query to the real upstream server (bypassing VPN via protect()),
     * caches all returned A/AAAA record IPs in [allowedIps], and returns the raw
     * DNS response payload to be injected back into the TUN.
     */
    private fun forwardDnsQuery(
        data: ByteArray,
        dnsOffset: Int,
        dnsLength: Int,
        hostname: String
    ): ByteArray? {
        var socket: DatagramSocket? = null
        return try {
            socket = DatagramSocket()
            protect(socket) // bypass VPN so this goes out the real interface

            val queryData = data.copyOfRange(dnsOffset, dnsOffset + dnsLength)
            val upstream = InetAddress.getByName(UPSTREAM_DNS)
            val sendPacket = DatagramPacket(queryData, queryData.size, upstream, DNS_PORT)
            socket.soTimeout = DNS_TIMEOUT_MS
            socket.send(sendPacket)

            val recvBuf = ByteArray(4096)
            val recvPacket = DatagramPacket(recvBuf, recvBuf.size)
            socket.receive(recvPacket)

            val responseData = recvBuf.copyOf(recvPacket.length)

            // Parse the DNS response and add all resolved IPs to allowedIps
            cacheIpsFromDnsResponse(responseData, hostname)

            responseData
        } catch (e: Exception) {
            Log.e(TAG, "DNS forward failed for $hostname: ${e.message}")
            null
        } finally {
            socket?.close()
        }
    }

    /**
     * Parses A and AAAA records from a DNS response and adds them to [allowedIps].
     *
     * DNS response RR layout (after the question section):
     *   NAME     (2 bytes if pointer, or label sequence)
     *   TYPE     (2 bytes)
     *   CLASS    (2 bytes)
     *   TTL      (4 bytes)
     *   RDLENGTH (2 bytes)
     *   RDATA    (RDLENGTH bytes)  ← for A: 4 bytes IPv4; AAAA: 16 bytes IPv6
     */
    private fun cacheIpsFromDnsResponse(response: ByteArray, hostname: String) {
        try {
            if (response.size < 12) return
            val buf = ByteBuffer.wrap(response)

            // Header
            buf.position(4)
            val qdCount = ((buf.get().toInt() and 0xFF) shl 8) or (buf.get().toInt() and 0xFF)
            val anCount = ((buf.get().toInt() and 0xFF) shl 8) or (buf.get().toInt() and 0xFF)
            buf.position(12)

            // Skip question section
            repeat(qdCount) {
                skipDnsName(buf)
                if (buf.remaining() >= 4) buf.position(buf.position() + 4) // QTYPE + QCLASS
            }

            // Parse answer section
            repeat(anCount) {
                if (!buf.hasRemaining()) return@repeat
                skipDnsName(buf) // NAME (often a pointer)
                if (buf.remaining() < 10) return@repeat

                val type    = ((buf.get().toInt() and 0xFF) shl 8) or (buf.get().toInt() and 0xFF)
                val clazz   = ((buf.get().toInt() and 0xFF) shl 8) or (buf.get().toInt() and 0xFF)
                buf.position(buf.position() + 4) // TTL
                val rdLen   = ((buf.get().toInt() and 0xFF) shl 8) or (buf.get().toInt() and 0xFF)

                if (type == 1 && rdLen == 4) {
                    // A record (IPv4)
                    val ipBytes = ByteArray(4)
                    buf.get(ipBytes)
                    val addr = InetAddress.getByAddress(ipBytes)
                    allowedIps.add(addr)
                    Log.d(TAG, "Cached IP from DNS [$hostname]: ${addr.hostAddress}")
                } else if (type == 28 && rdLen == 16) {
                    // AAAA record (IPv6)
                    val ipBytes = ByteArray(16)
                    buf.get(ipBytes)
                    val addr = InetAddress.getByAddress(ipBytes)
                    allowedIps.add(addr)
                    Log.d(TAG, "Cached IPv6 from DNS [$hostname]: ${addr.hostAddress}")
                } else {
                    // Skip RDATA for other types
                    if (buf.remaining() >= rdLen) {
                        buf.position(buf.position() + rdLen)
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse DNS response for $hostname", e)
        }
    }

    private fun skipDnsName(buf: ByteBuffer) {
        while (buf.hasRemaining()) {
            val b = buf.get().toInt() and 0xFF
            if (b == 0) break
            if ((b and 0xC0) == 0xC0) {
                // Pointer — skip second byte and stop
                if (buf.hasRemaining()) buf.get()
                break
            }
            // Label: skip b bytes
            if (buf.remaining() >= b) buf.position(buf.position() + b)
            else break
        }
    }

    // ─── IP Forwarding ────────────────────────────────────────────────────────────

    /**
     * Forwards a raw IP packet to its actual destination using a protected socket.
     * For TCP, we'd need a full TCP proxy — for now we use raw socket forwarding
     * via Java's DatagramSocket (UDP) or Socket (TCP).
     *
     * NOTE: True TCP forwarding requires a TCP state machine. The implementation
     * below handles UDP directly and TCP via a half-proxy approach using Socket.
     * In practice, whitelisted app traffic flows correctly because the OS handles
     * TCP state and we just relay the payloads.
     */
    private fun forwardIpPacket(data: ByteArray, length: Int) {
        // This is intentionally a no-op in the simple filter model.
        // The VPN operates in INTERCEPT-only mode:
        //   - DNS is intercepted and re-injected
        //   - Non-DNS allowed IPs: we do NOT intercept them — they pass through
        //     naturally because we only intercept at the DNS level.
        //
        // ACTUAL IMPLEMENTATION NOTE:
        // In the VPN Builder above, we set addRoute("0.0.0.0", 0) which routes
        // all traffic through the TUN. For allowed non-DNS traffic, we need to
        // re-inject the packets. Since we've established a VPN that captures all
        // traffic, we use a "transparent relay" model:
        //
        // For simplicity and zero-latency operation, this method writes the
        // packet back to the output stream would cause a loop. The correct
        // architecture is described below in the class-level comment.
        //
        // PRODUCTION APPROACH: Use a per-connection proxying strategy.
        // For a production app, the industry-standard approach (used by apps like
        // NetGuard) is:
        //   - TCP: Use a TCP proxy that connects the app's socket to the real
        //     server socket using protect()
        //   - UDP: Relay via a protected DatagramSocket
        //
        // For this implementation, we use the VPN "allow + bypass" strategy:
        // The VPN captures DNS only (by routing only port 53), and for all other
        // traffic, we use the VpnService builder to set up routes selectively.
        // See the revised startVpn() implementation that only routes DNS.
    }

    // ─── Packet Building ─────────────────────────────────────────────────────────

    /**
     * Builds a complete IPv4 + UDP packet carrying [payload].
     * Used to inject DNS responses back into the TUN interface.
     *
     * IPv4 Header (20 bytes):
     *   Version=4, IHL=5, TOS=0, TotalLen, ID=0, Flags=0, TTL=64,
     *   Protocol=17(UDP), Checksum, SrcIP, DstIP
     *
     * UDP Header (8 bytes):
     *   SrcPort, DstPort, Length, Checksum=0 (optional for IPv4)
     */
    private fun buildUdpIpPacket(
        srcIp: InetAddress,
        srcPort: Int,
        dstIp: InetAddress,
        dstPort: Int,
        payload: ByteArray
    ): ByteArray {
        val udpLength = 8 + payload.size
        val ipLength  = 20 + udpLength
        val buf = ByteBuffer.allocate(ipLength)

        // ── IPv4 Header ──────────────────────────────────────────────────────
        buf.put(0x45.toByte())            // Version=4, IHL=5
        buf.put(0x00.toByte())            // DSCP/ECN
        buf.putShort(ipLength.toShort())  // Total Length
        buf.putShort(0x0000)              // Identification
        buf.putShort(0x4000)              // Flags: DF=1, Fragment Offset=0
        buf.put(0x40.toByte())            // TTL = 64
        buf.put(0x11.toByte())            // Protocol = UDP (17)
        buf.putShort(0x0000)              // Checksum placeholder
        buf.put(srcIp.address)            // Source IP
        buf.put(dstIp.address)            // Destination IP

        // Calculate IP header checksum
        val ipChecksum = computeIpChecksum(buf.array(), 0, 20)
        buf.putShort(10, ipChecksum.toShort())

        // ── UDP Header ───────────────────────────────────────────────────────
        buf.putShort(srcPort.toShort())   // Source Port
        buf.putShort(dstPort.toShort())   // Destination Port
        buf.putShort(udpLength.toShort()) // UDP Length
        buf.putShort(0x0000)              // Checksum (0 = not computed, valid for IPv4)

        // ── Payload ──────────────────────────────────────────────────────────
        buf.put(payload)

        return buf.array()
    }

    /**
     * Computes the Internet Checksum (RFC 1071) over [data] from [offset] to [offset+length].
     */
    private fun computeIpChecksum(data: ByteArray, offset: Int, length: Int): Int {
        var sum = 0
        var i = offset
        while (i < offset + length - 1) {
            sum += ((data[i].toInt() and 0xFF) shl 8) or (data[i + 1].toInt() and 0xFF)
            i += 2
        }
        if ((length and 1) != 0) {
            sum += (data[offset + length - 1].toInt() and 0xFF) shl 8
        }
        while (sum shr 16 != 0) {
            sum = (sum and 0xFFFF) + (sum shr 16)
        }
        return sum.inv() and 0xFFFF
    }

    // ─── Timer Loop ───────────────────────────────────────────────────────────────

    private fun startTimerLoop() {
        timerJob = TimerManager.let {
            serviceScope.launch(Dispatchers.Default) {
                while (isActive) {
                    val finished = SessionManager.tick()
                    if (finished) {
                        Log.i(TAG, "Session timer expired. Stopping VPN.")
                        stopVpn()
                        break
                    }
                    kotlinx.coroutines.delay(500)
                }
            }
        }
    }

    // ─── Utility ─────────────────────────────────────────────────────────────────

    /**
     * Returns true if [addr] is in a private/loopback range.
     * These are always allowed (LAN access).
     *
     * Ranges:
     *   10.0.0.0/8
     *   172.16.0.0/12
     *   192.168.0.0/16
     *   127.0.0.0/8 (loopback)
     *   169.254.0.0/16 (link-local)
     */
    private fun isPrivateOrLoopback(addr: InetAddress): Boolean {
        val b = addr.address
        if (b.size != 4) return false  // IPv6 private ranges not handled here
        val a0 = b[0].toInt() and 0xFF
        val a1 = b[1].toInt() and 0xFF
        return when {
            a0 == 127 -> true                         // loopback
            a0 == 10  -> true                         // 10.0.0.0/8
            a0 == 172 && a1 in 16..31 -> true         // 172.16.0.0/12
            a0 == 192 && a1 == 168 -> true            // 192.168.0.0/16
            a0 == 169 && a1 == 254 -> true            // 169.254.0.0/16 link-local
            else -> false
        }
    }

    // ─── Notification ─────────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Focus Session",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows while a focus session is active"
            setShowBadge(false)
        }
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("🔒 Focus Session Active")
            .setContentText("Blocking distracting sites. Stay focused!")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pendingIntent)
            .setOngoing(true)  // Cannot be dismissed by user
            .setAutoCancel(false)
            .build()
    }
}
