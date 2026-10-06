/**
 * Soft deletion (Backend PRD section 26.8).
 *
 * Nothing the application does ever physically deletes a business row. This
 * Prisma client extension, applied to every model that has a `deletedAt`
 * column, makes that automatic:
 *
 *  - reads (`findMany`, `findFirst`, `findUnique`, `count`, ...) skip rows
 *    whose `deletedAt` is set;
 *  - `delete` / `deleteMany` become updates that set `deletedAt`;
 *  - `update` / `updateMany` never touch an already deleted row.
 *
 * To read deleted rows deliberately (admin screens, audits) wrap the call in
 * `withDeleted(() => ...)`, or filter on `deletedAt` yourself: an explicit
 * `where.deletedAt` always wins.
 *
 * The database enforces the same rule with `BEFORE DELETE` triggers, so a raw
 * `DELETE` fails even if code forgets to use this extension.
 *
 * Soft-deletable models are discovered from the Prisma schema (any model with
 * a `deletedAt` field), so new tables are covered the moment they have the
 * column.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma } from '@prisma/client';

const includeDeleted = new AsyncLocalStorage<boolean>();

/** Run `fn` with soft-deleted rows visible to reads and updates. */
export function withDeleted<T>(fn: () => PromiseLike<T>): Promise<T> {
  // Await inside run(): Prisma queries are lazy and only execute when awaited,
  // so the flag must still be set at that moment.
  return includeDeleted.run(true, async () => await fn());
}

export const SOFT_DELETABLE_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'deletedAt'))
    .map((model) => model.name),
);

type Args = { where?: Record<string, unknown> } & Record<string, unknown>;

function scoped(args: Args | undefined): Args {
  if (includeDeleted.getStore()) {
    return args ?? {};
  }
  // The caller's own `deletedAt` filter, if any, takes precedence.
  return { ...args, where: { deletedAt: null, ...args?.where } };
}

type ModelContext = {
  $name: string;
  $parent: Record<
    string,
    {
      delete: (args: unknown) => Promise<unknown>;
      deleteMany: (args: unknown) => Promise<unknown>;
    }
  >;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<unknown>;
};

export const softDeleteExtension = Prisma.defineExtension({
  name: 'soft-delete',
  query: {
    $allModels: {
      async findMany({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async findFirst({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async findFirstOrThrow({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async findUnique({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async findUniqueOrThrow({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async count({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async aggregate({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async groupBy({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async update({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
      async updateMany({ model, args, query }) {
        return query(SOFT_DELETABLE_MODELS.has(model) ? (scoped(args) as typeof args) : args);
      },
    },
  },
  // delete / deleteMany are rewritten as model methods because they need to
  // call update / updateMany on the same model.
  model: {
    $allModels: {
      async delete(this: unknown, args: Args) {
        const context = Prisma.getExtensionContext(this) as unknown as ModelContext;
        if (!SOFT_DELETABLE_MODELS.has(context.$name)) {
          // append-only and transient tables are guarded by the database
          return context.$parent[context.$name].delete(args);
        }
        return context.update({ where: args.where, data: { deletedAt: new Date() } });
      },
      async deleteMany(this: unknown, args?: Args) {
        const context = Prisma.getExtensionContext(this) as unknown as ModelContext;
        if (!SOFT_DELETABLE_MODELS.has(context.$name)) {
          return context.$parent[context.$name].deleteMany(args);
        }
        return context.updateMany({ where: args?.where, data: { deletedAt: new Date() } });
      },
    },
  },
});
