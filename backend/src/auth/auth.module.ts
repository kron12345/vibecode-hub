import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KeycloakStrategy } from './keycloak.strategy';
import { AuthGuard } from './auth.guard';
import { WsJwtGuard } from './ws-jwt.guard';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'keycloak' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET', 'dev-secret-change-in-production'),
      }),
    }),
  ],
  providers: [KeycloakStrategy, AuthGuard, WsJwtGuard],
  exports: [AuthGuard, WsJwtGuard, PassportModule],
})
export class AuthModule {}
