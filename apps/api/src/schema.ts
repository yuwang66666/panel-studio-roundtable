import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const connections = sqliteTable('model_connections', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  active: integer('active').notNull(),
  dataJson: text('data_json').notNull(),
});
export const discussions = sqliteTable('discussions', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
  generation: integer('generation').notNull(),
  updatedAt: text('updated_at').notNull(),
  dataJson: text('data_json').notNull(),
  hostConnectionId: text('host_connection_id'),
  hostVersion: integer('host_version'),
});
