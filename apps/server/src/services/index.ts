import { AdminService } from './admin-service.ts';
import type { ServiceDeps } from './context.ts';
import { OrgService, type OrgServiceOptions } from './org-service.ts';
import { SignInPolicy } from './sign-in-policy.ts';
import { UserService } from './user-service.ts';

export interface Services {
  orgs: OrgService;
  users: UserService;
  admin: AdminService;
  signIn: SignInPolicy;
}

export function createServices(deps: ServiceDeps, options: OrgServiceOptions = {}): Services {
  const orgs = new OrgService(deps, options);
  return {
    orgs,
    users: new UserService(deps),
    admin: new AdminService(deps),
    signIn: new SignInPolicy(deps, orgs),
  };
}

export type { Actor, ServiceDeps } from './context.ts';
