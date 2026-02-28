import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class KeycloakStrategy extends PassportStrategy(Strategy, 'keycloak') {
  constructor(config: ConfigService) {
    const keycloakUrl = config.get('KEYCLOAK_URL', 'https://sso.example.com');
    const realm = config.get('KEYCLOAK_REALM', 'vibcodehub');
    const issuer = `${keycloakUrl}/realms/${realm}`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      issuer,
      algorithms: ['RS256'],
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
      }),
    });
  }

  validate(payload: Record<string, unknown>) {
    return {
      id: payload.sub,
      username: payload.preferred_username,
      email: payload.email,
      roles: (payload.realm_access as Record<string, string[]>)?.roles ?? [],
    };
  }
}
