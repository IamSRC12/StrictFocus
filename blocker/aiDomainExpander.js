/**
 * blocker/aiDomainExpander.js
 * Uses Groq LLM to automatically discover third-party dependencies (CDNs, APIs, video players)
 * for the whitelisted domains, so they load perfectly without manual tweaking.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Instruct the LLM to return strict JSON so we can parse it safely.
const SYSTEM_PROMPT = `You are a network security and web infrastructure expert.
The user wants to whitelist specific websites in a DNS-level firewall blocker.
Given a list of base domains, you must identify ALL essential third-party domains, CDNs, APIs, video players, and tracking domains required for the site to function.
Return ONLY a valid JSON object with a "domains" key containing an array of domain strings. Do not include any markdown formatting or extra text.
Example output: {"domains": ["api.penpencil.co", "player.vimeo.com", "cdn.cloudflare.net"]}`;

async function expandWhitelist(domains, groqApiKey) {
  if (!groqApiKey || domains.length === 0) return domains;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Base domains: ${JSON.stringify(domains)}` }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      console.error('[AI Expander] Groq API failed:', response.statusText);
      return domains;
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '{}';

    const parsed = JSON.parse(content);
    const aiDomains = Array.isArray(parsed) ? parsed : (parsed.domains || []);

    const combined = new Set([...domains, ...aiDomains.map(d => typeof d === 'string' ? d.toLowerCase().trim() : '').filter(Boolean)]);

    console.log(`[AI Expander] Expanded whitelist from ${domains.length} to ${combined.size} domains.`);
    return Array.from(combined);

  } catch (e) {
    console.error('[AI Expander] Error:', e.message);
    return domains;
  }
}

module.exports = { expandWhitelist };
