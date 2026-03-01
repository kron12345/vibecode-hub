import { Injectable, inject } from '@angular/core';
import Keycloak from 'keycloak-js';

@Injectable({ providedIn: 'root' })
export class AuthInfoService {
  private readonly keycloak = inject(Keycloak);

  get isAdmin(): boolean {
    return this.keycloak.hasRealmRole('admin');
  }

  get userId(): string {
    return this.keycloak.tokenParsed?.sub ?? '';
  }

  get username(): string {
    return (this.keycloak.tokenParsed as any)?.preferred_username ?? '';
  }

  get roles(): string[] {
    return this.keycloak.tokenParsed?.realm_access?.roles ?? [];
  }
}
