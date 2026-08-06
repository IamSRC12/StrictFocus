/**
 * blocker/aiDomainExpander.js
 * Uses a curated companion map (always active) + optional Groq LLM call to automatically
 * discover third-party CDN/API dependencies for whitelisted domains.
 *
 * Layer 1 (always): curated COMPANIONS map + GENERIC_CDN (if relaxed mode)
 * Layer 2 (optional): Groq LLM call for unknown domains
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Models in preference order (llama3-8b-8192 is retired)
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

const SYSTEM_PROMPT = `You are a network security and web infrastructure expert.
The user wants to whitelist specific websites in a DNS-level firewall blocker.
Given a list of base domains, identify ALL essential third-party domains, CDNs, APIs, and video players required for those sites to function.
Return ONLY a valid JSON object with a "domains" key containing an array of domain strings. No markdown, no extra text.
Example: {"domains": ["api.penpencil.co", "player.vimeo.com", "cdn.cloudflare.net"]}`;

// ─── Curated companion map (mirrors Android DomainRules.kt) ─────────────────

const INFRA_ALWAYS_ALLOW = [
  'connectivitycheck.gstatic.com', 'clients3.google.com', 'captive.apple.com',
  'time.android.com', 'android.clients.google.com', 'mtalk.google.com',
  'firebaseinstallations.googleapis.com', 'play.googleapis.com',
  'msftconnecttest.com', 'msftncsi.com', 'detectportal.firefox.com', 'nmcheck.gnome.org'
];

const COMPANIONS = {
  'pw.live':        ['penpencil.co', 'api.penpencil.co', 'penpencil.xyz', 'pwcdn.in', 'static.pw.live',
                     'd1d34p8vz63oiq.cloudfront.net', 'razorpay.com', 'clarity.ms', 'sentry.io'],
  'unacademy.com':  ['uacdn.net', 'unacademycdn.net', 'graphql.unacademy.com'],
  'notion.so':      ['notion-static.com', 'amazonaws.com', 'notion.site'],
  'figma.com':      ['figma-alpha-api.s3.us-west-2.amazonaws.com', 'figma.design'],
  'leetcode.com':   ['lcicdn.com', 'leetcode.cn', 'algorithms.qiniucdn.com'],
  'youtube.com':    ['googlevideo.com', 'ytimg.com', 'googleapis.com', 'gstatic.com', 'yt3.ggpht.com'],
  'google.com':     ['googleapis.com', 'gstatic.com', 'googleusercontent.com'],
  'github.com':     ['githubusercontent.com', 'githubassets.com', 'github.githubassets.com'],
  'stackoverflow.com': ['sstatic.net', 'cdn.sstatic.net'],
  'reddit.com':     ['redd.it', 'redditmedia.com', 'reddituploads.com', 'redd.it'],
  'twitter.com':    ['t.co', 'twimg.com', 'pbs.twimg.com', 'abs.twimg.com'],
  'x.com':          ['t.co', 'twimg.com', 'pbs.twimg.com', 'abs.twimg.com'],
  'discord.com':    ['discordapp.com', 'discordapp.net', 'discord.gg', 'discordstatus.com'],
  'spotify.com':    ['scdn.co', 'spotifycdn.net', 'audio-sp-*.pscdn.co'],
};

/** Normalizes a domain string (strips scheme, www, path, trailing dot). */
function normalize(raw) {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/\.$/, '');
}

/** Expand base domains using the curated companion map. */
function expandWithCompanions(domains) {
  const out = new Set();
  for (const d of domains) {
    const n = normalize(d);
    out.add(n);
    const companions = COMPANIONS[n] || [];
    for (const c of companions) out.add(normalize(c));
  }
  for (const infra of INFRA_ALWAYS_ALLOW) out.add(infra);
  return out;
}

// ─── Groq LLM expansion ──────────────────────────────────────────────────────

async function tryGroqExpand(domains, groqApiKey, progressCallback) {
  for (const model of GROQ_MODELS) {
    try {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Base domains: ${JSON.stringify(domains)}` }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        if (response.status === 404 || response.status === 400) {
          // Model not found — try next
          console.warn(`[AI Expander] Model ${model} unavailable, trying next.`);
          continue;
        }
        progressCallback && progressCallback(`AI: Groq API error (${response.status}) — using companion map only`, 0);
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
      const aiDomains = Array.isArray(parsed) ? parsed : (parsed.domains || []);
      console.log(`[AI Expander] Groq (${model}) returned ${aiDomains.length} domains.`);
      return aiDomains.map(d => typeof d === 'string' ? normalize(d) : '').filter(Boolean);

    } catch (e) {
      console.error(`[AI Expander] Model ${model} error:`, e.message);
    }
  }
  progressCallback && progressCallback('AI: All Groq models failed — using companion map only', 0);
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Expands a whitelist with:
 *   1. Curated companion map (always runs)
 *   2. Groq LLM call (optional, requires API key)
 *
 * @param {string[]} domains     Base domains to expand.
 * @param {string}   groqApiKey  Groq API key (pass '' to skip LLM).
 * @param {function} [progressCallback]  Called with (message, count) for UI updates.
 * @returns {Promise<string[]>}  Deduplicated expanded domain list.
 */
async function expandWhitelist(domains, groqApiKey, progressCallback) {
  // Always run companion map expansion
  const combined = expandWithCompanions(domains);
  console.log(`[AI Expander] Companion map: ${domains.length} → ${combined.size} domains.`);

  if (groqApiKey && groqApiKey.startsWith('gsk_')) {
    progressCallback && progressCallback('AI: Querying Groq for additional dependencies...', 0);
    const aiDomains = await tryGroqExpand(domains, groqApiKey, progressCallback);
    if (aiDomains) {
      let added = 0;
      for (const d of aiDomains) {
        if (!combined.has(d)) { combined.add(d); added++; }
      }
      progressCallback && progressCallback(`AI: Found ${added} additional dependencies`, added);
      console.log(`[AI Expander] Groq added ${added} new domains. Total: ${combined.size}.`);
    }
  }

  return Array.from(combined);
}

module.exports = { expandWhitelist };



