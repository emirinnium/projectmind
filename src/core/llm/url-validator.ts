/**
 * Validates and sanitizes API URLs for LLM providers.
 * Prevents MITM attacks by ensuring only HTTPS URLs to known API endpoints.
 */

// Known official API hostnames for each provider
const OFFICIAL_API_HOSTNAMES: Record<string, string[]> = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com'],
  gemini: ['generativelanguage.googleapis.com'],
  groq: ['api.groq.com'],
  ollama: [], // Ollama is self-hosted, so any localhost/private IP is allowed
};

export class ApiUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUrlValidationError';
  }
}

/**
 * Validates an API URL for a given provider.
 * @throws ApiUrlValidationError if URL is invalid or potentially dangerous
 */
export function validateApiUrl(url: string, provider: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiUrlValidationError(`Invalid URL: ${url}`);
  }

  // Must use HTTPS (except for local Ollama)
  if (parsed.protocol !== 'https:' && provider !== 'ollama') {
    throw new ApiUrlValidationError(
      `API URL must use HTTPS for ${provider}. Got: ${parsed.protocol}`
    );
  }

  // Check for localhost/private IPs (only allowed for Ollama)
  const hostname = parsed.hostname.toLowerCase();
  if (provider === 'ollama') {
    if (!isLocalOrPrivateHost(hostname)) {
      throw new ApiUrlValidationError(
        `Ollama URL must point to localhost or private network. Got: ${hostname}`
      );
    }
    return url;
  }

  // For cloud providers, validate against known hostnames
  const allowedHostnames = OFFICIAL_API_HOSTNAMES[provider];
  if (allowedHostnames && allowedHostnames.length > 0) {
    if (!allowedHostnames.includes(hostname)) {
      throw new ApiUrlValidationError(
        `API URL for ${provider} must point to official endpoint (${allowedHostnames.join(', ')}). Got: ${hostname}. ` +
        `Custom endpoints are disabled for security.`
      );
    }
  }

  return url;
}

/**
 * Check if a hostname is a localhost or private network address.
 */
function isLocalOrPrivateHost(hostname: string): boolean {
  // Localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Private IP ranges
  const privateRanges = [
    /^10\./,                              // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[01])\./,     // 172.16.0.0/12
    /^192\.168\./,                        // 192.168.0.0/16
    /^169\.254\./,                        // Link-local
    /^fd[0-9a-f]{2}:/i,                   // IPv6 unique local
    /^fe80:/i,                            // IPv6 link-local
  ];

  return privateRanges.some((range) => range.test(hostname));
}
