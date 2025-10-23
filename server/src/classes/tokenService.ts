import axios from 'axios';

type TokenServiceConfig = {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
};

export class TokenService {
  private clientId: string;
  private clientSecret: string;
  private tokenUrl: string;
  private accessToken: string | null = null;
  private expiry: number = 0;

  constructor(config: TokenServiceConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.tokenUrl = config.tokenUrl;
  }

  public async getAccessToken(): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);
    const bufferTime = 10;

    if (this.accessToken && now < this.expiry)
      return this.accessToken;

    const response = await axios.post(
      this.tokenUrl,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, expires_in } = response.data;
    this.accessToken = access_token;
    this.expiry = now + expires_in - bufferTime;
    return this.accessToken;
  }
}
