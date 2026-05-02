import axios from 'axios';

type TokenServiceConfig = {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
};

export type GetAccessTokenOptions = {
  mode?: 'service' | 'admin';
  scope?: string;
};

const BUFFER_SECONDS = 10;
const DEFAULT_TTL_SECONDS = 60;

function isSelfIssuedMode(): boolean {
  const flag = String(process.env.USE_SELF_ISSUED_SERVICE_TOKENS ?? '').toLowerCase().trim();
  const flagOn = flag === 'true' || flag === '1' || flag === 'yes';
  return flagOn
    && Boolean(process.env.SERVICE_TOKEN_URL)
    && Boolean(process.env.SERVICE_CLIENT_ID)
    && Boolean(process.env.SERVICE_CLIENT_SECRET);
}

export class TokenService {
  private clientId: string;
  private clientSecret: string;
  private tokenUrl: string;
  private cache = new Map<string, { token: string; expiry: number }>();

  constructor(config: TokenServiceConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.tokenUrl = config.tokenUrl;
  }

  public async getAccessToken(opts: GetAccessTokenOptions = {}): Promise<string> {
    const mode = opts.mode ?? 'service';
    const scope = opts.scope;
    const now = Math.floor(Date.now() / 1000);

    const useSelfIssued = mode === 'service' && isSelfIssuedMode();
    const tokenUrl = useSelfIssued ? (process.env.SERVICE_TOKEN_URL as string) : this.tokenUrl;
    const clientId = useSelfIssued ? (process.env.SERVICE_CLIENT_ID as string) : this.clientId;
    const clientSecret = useSelfIssued ? (process.env.SERVICE_CLIENT_SECRET as string) : this.clientSecret;

    const cacheKey = `${tokenUrl}|${clientId}|${scope ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached && now < cached.expiry) return cached.token;

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (scope) params.append('scope', scope);

    const response = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, expires_in } = response.data;
    this.cache.set(cacheKey, {
      token: access_token,
      expiry: now + (expires_in ?? DEFAULT_TTL_SECONDS) - BUFFER_SECONDS,
    });
    return access_token;
  }
}
