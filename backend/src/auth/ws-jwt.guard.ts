import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';
import jwksRsa from 'jwks-rsa';
import jwt from 'jsonwebtoken';

export interface WsUser {
  id: string;
  username: string;
  email: string;
  roles: string[];
}

/**
 * Validates JWT tokens on WebSocket connections using the Keycloak JWKS endpoint.
 * Used by all WebSocket gateways in handleConnection() to authenticate clients.
 */
@Injectable()
export class WsJwtGuard {
  private readonly logger = new Logger(WsJwtGuard.name);
  private readonly jwksClient: jwksRsa.JwksClient;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    const keycloakUrl = config.get('KEYCLOAK_URL', 'https://sso.example.com');
    const realm = config.get('KEYCLOAK_REALM', 'vibcodehub');
    this.issuer = `${keycloakUrl}/realms/${realm}`;

    this.jwksClient = jwksRsa({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 5,
      jwksUri: `${this.issuer}/protocol/openid-connect/certs`,
    });
  }

  /**
   * Validate a WebSocket client connection.
   * Extracts the JWT from handshake.auth.token or Authorization header,
   * verifies it against Keycloak JWKS, and attaches user data to the socket.
   *
   * @returns The authenticated user or null if validation fails
   */
  async validateConnection(client: Socket): Promise<WsUser | null> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.warn(
          `WS client ${client.id}: No auth token provided — disconnecting`,
        );
        return null;
      }

      const user = await this.verifyToken(token);
      // Attach user to socket data for downstream use
      (client as any).user = user;
      return user;
    } catch (error) {
      this.logger.warn(
        `WS client ${client.id}: JWT validation failed — ${error.message}`,
      );
      return null;
    }
  }

  private extractToken(client: Socket): string | null {
    // 1. socket.io auth object (preferred — set via client `auth` option)
    const authToken = client.handshake?.auth?.token;
    if (authToken && typeof authToken === 'string') {
      return authToken.replace(/^Bearer\s+/i, '');
    }

    // 2. Authorization header fallback
    const authHeader = client.handshake?.headers?.authorization;
    if (authHeader && typeof authHeader === 'string') {
      return authHeader.replace(/^Bearer\s+/i, '');
    }

    return null;
  }

  private async verifyToken(token: string): Promise<WsUser> {
    // Decode header to get kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      throw new Error('Invalid token format');
    }

    const kid = decoded.header.kid;
    if (!kid) {
      throw new Error('Token missing kid header');
    }

    // Get signing key from JWKS
    const key = await this.jwksClient.getSigningKey(kid);
    const signingKey = key.getPublicKey();

    // Verify token
    const payload = jwt.verify(token, signingKey, {
      issuer: this.issuer,
      algorithms: ['RS256'],
    }) as Record<string, any>;

    return {
      id: payload.sub as string,
      username: (payload.preferred_username as string) ?? '',
      email: (payload.email as string) ?? '',
      roles:
        (payload.realm_access as Record<string, string[]>)?.roles ?? [],
    };
  }
}
