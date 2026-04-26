import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    password_hash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"),
    status: text("status").notNull().default("active"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    last_login_at: timestamp("last_login_at"),
  },
  (t) => ({
    email_unique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;

export type UserRole = "user" | "admin" | "super_admin";
export type UserStatus = "active" | "disabled";
