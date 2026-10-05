import { AdminService } from './admin-service.ts';
import { BackupService } from './backup-service.ts';
import type { ServiceDeps } from './context.ts';
import { GroupService } from './group-service.ts';
import { IdempotencyStore } from './idempotency-store.ts';
import { OrderingService } from './ordering-service.ts';
import { OrgService, type OrgServiceOptions } from './org-service.ts';
import { PlacementService } from './placement-service.ts';
import { RetentionService } from './retention-service.ts';
import { SignInPolicy } from './sign-in-policy.ts';
import { TagService } from './tag-service.ts';
import { expansionRemovalStep, TaskService } from './task-service.ts';
import { UserService } from './user-service.ts';

export interface Services {
  orgs: OrgService;
  users: UserService;
  admin: AdminService;
  signIn: SignInPolicy;
  ordering: OrderingService;
  placements: PlacementService;
  groups: GroupService;
  tasks: TaskService;
  tags: TagService;
  idempotency: IdempotencyStore;
  retention: RetentionService;
  backups: BackupService;
}

export function createServices(deps: ServiceDeps, options: OrgServiceOptions = {}): Services {
  const ordering = new OrderingService();
  const placements = new PlacementService(deps, ordering);
  const idempotency = new IdempotencyStore(deps);
  const orgs = new OrgService(deps, {
    memberRemovalSteps: [
      placements.memberRemovalStep,
      expansionRemovalStep,
      ...(options.memberRemovalSteps ?? []),
    ],
  });
  return {
    orgs,
    users: new UserService(deps),
    admin: new AdminService(deps),
    signIn: new SignInPolicy(deps, orgs),
    ordering,
    placements,
    groups: new GroupService(deps, ordering, placements),
    tasks: new TaskService(deps, placements, ordering),
    tags: new TagService(deps),
    idempotency,
    retention: new RetentionService(deps, placements, idempotency),
    backups: new BackupService(deps),
  };
}

export type { Actor, OpMeta, ServiceDeps } from './context.ts';
