import { EventBus } from '../events/bus.ts';
import { AdminService } from './admin-service.ts';
import { BackupService } from './backup-service.ts';
import type { ServiceDeps } from './context.ts';
import { ExportService } from './export-service.ts';
import { GroupService } from './group-service.ts';
import { IdempotencyStore } from './idempotency-store.ts';
import { OrderingService } from './ordering-service.ts';
import { OrgService, type OrgServiceOptions } from './org-service.ts';
import { PlacementService } from './placement-service.ts';
import { RetentionService } from './retention-service.ts';
import { SearchService } from './search-service.ts';
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
  search: SearchService;
  exports: ExportService;
  idempotency: IdempotencyStore;
  retention: RetentionService;
  backups: BackupService;
  /** Domain events, published after commit (04 §4.5). */
  events: EventBus;
}

export function createServices(
  input: Omit<ServiceDeps, 'events'> & { events?: EventBus },
  options: OrgServiceOptions = {},
): Services {
  const deps: ServiceDeps = { ...input, events: input.events ?? new EventBus(input.logger) };
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
  const search = new SearchService(deps);
  return {
    orgs,
    users: new UserService(deps),
    admin: new AdminService(deps),
    signIn: new SignInPolicy(deps, orgs),
    ordering,
    placements,
    groups: new GroupService(deps, ordering, placements),
    tasks: new TaskService(deps, placements, ordering, search),
    tags: new TagService(deps),
    search,
    exports: new ExportService(deps),
    idempotency,
    retention: new RetentionService(deps, placements, idempotency),
    backups: new BackupService(deps),
    events: deps.events,
  };
}

export type { Actor, OpMeta, ServiceDeps } from './context.ts';
