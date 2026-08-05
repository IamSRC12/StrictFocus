package com.strictfocus.app

import java.nio.ByteBuffer

/**
 * Lightweight DNS packet parser and builder for the VPN packet filter.
 *
 * DNS wire format (RFC 1035):
 *   Header (12 bytes):
 *     [0-1]  Transaction ID
 *     [2-3]  Flags
 *     [4-5]  QDCOUNT (number of questions)
 *     [6-7]  ANCOUNT (number of answer RRs)
 *     [8-9]  NSCOUNT (number of authority RRs)
 *     [10-11] ARCOUNT (number of additional RRs)
 *   Question section:
 *     QNAME  (sequence of labels, each length-prefixed, ending with 0x00)
 *     QTYPE  (2 bytes)
 *     QCLASS (2 bytes)
 */
object DnsPacket {

    private const val DNS_FLAG_QR_RESPONSE: Int  = 0x8000
    private const val DNS_FLAG_AA: Int            = 0x0400
    private const val DNS_FLAG_RD: Int            = 0x0100
    private const val DNS_FLAG_RA: Int            = 0x0080
    private const val DNS_RCODE_NXDOMAIN: Int     = 0x0003

    private const val DNS_TYPE_A: Int    = 1
    private const val DNS_TYPE_AAAA: Int = 28
    private const val DNS_CLASS_IN: Int  = 1

    // ─── Parsing ────────────────────────────────────────────────────────────────

    /**
     * Parses the first question's hostname from a DNS query payload.
     * Returns null if the payload is malformed.
     */
    fun parseQueryHostname(payload: ByteArray, offset: Int = 0, length: Int = payload.size - offset): String? {
        return try {
            if (length < 12) return null
            val buf = ByteBuffer.wrap(payload, offset, length)
            // Skip 12-byte header
            buf.position(offset + 12)
            readDnsName(buf)
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Reads a DNS name from the buffer at its current position.
     * Handles label sequences (does NOT follow pointers — we only parse questions).
     */
    private fun readDnsName(buf: ByteBuffer): String {
        val sb = StringBuilder()
        var first = true
        while (buf.hasRemaining()) {
            val len = buf.get().toInt() and 0xFF
            if (len == 0) break
            // Pointer compression (0xC0 prefix) — not expected in queries, skip gracefully
            if ((len and 0xC0) == 0xC0) {
                buf.get() // skip second byte of pointer
                break
            }
            if (!first) sb.append('.')
            first = false
            repeat(len) {
                sb.append(buf.get().toInt().toChar())
            }
        }
        return sb.toString().lowercase()
    }

    // ─── Building responses ─────────────────────────────────────────────────────

    /**
     * Builds an NXDOMAIN response for the given query.
     * This is returned for non-whitelisted domain queries so the app/browser
     * gets an immediate "domain not found" instead of a timeout.
     *
     * @param queryPayload The original raw DNS query payload bytes.
     * @param queryOffset  Offset into [queryPayload] where the DNS data starts.
     * @param queryLength  Length of the DNS query data.
     */
    fun buildNxDomainResponse(
        queryPayload: ByteArray,
        queryOffset: Int = 0,
        queryLength: Int = queryPayload.size - queryOffset
    ): ByteArray {
        if (queryLength < 12) return ByteArray(0)

        // Copy the original query and flip QR bit, set RCODE to NXDOMAIN
        val response = queryPayload.copyOfRange(queryOffset, queryOffset + queryLength)
        val flagsHigh = (response[2].toInt() and 0xFF)
        val flagsLow  = (response[3].toInt() and 0xFF)

        // Set QR=1 (response), AA=0, RD=keep, RA=1, RCODE=3 (NXDOMAIN)
        val newFlagsHigh = flagsHigh or 0x80  // QR bit
        val newFlagsLow  = (flagsLow and 0xF0.inv()) or DNS_RCODE_NXDOMAIN

        response[2] = newFlagsHigh.toByte()
        response[3] = newFlagsLow.toByte()
        // ANCOUNT = 0 (already 0 from query copy)
        return response
    }

    /**
     * Extracts the QTYPE from the first question of a DNS query.
     * Returns -1 if malformed.
     */
    fun parseQueryType(payload: ByteArray, offset: Int = 0, length: Int = payload.size - offset): Int {
        return try {
            if (length < 12) return -1
            val buf = ByteBuffer.wrap(payload, offset, length)
            buf.position(offset + 12)
            // Skip QNAME
            while (buf.hasRemaining()) {
                val len = buf.get().toInt() and 0xFF
                if (len == 0) break
                if ((len and 0xC0) == 0xC0) { buf.get(); break }
                buf.position(buf.position() + len)
            }
            // QTYPE is next 2 bytes
            if (buf.remaining() < 2) -1
            else ((buf.get().toInt() and 0xFF) shl 8) or (buf.get().toInt() and 0xFF)
        } catch (e: Exception) {
            -1
        }
    }
}
