import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { accessTokens, sessionMembers, users } from "../db/schema.js";

type Database = AppDatabase;

export type SessionAccessContext = {
  token: string;
  sessionId: string;
  memberId: string;
  userId: string;
  displayName: string;
  role: string;
};

export class AuthService {
  constructor(private readonly database: Database, private readonly tokenTtlSeconds: number) {}

  createAccessTokenExpiry() {
    return new Date(Date.now() + this.tokenTtlSeconds * 1000);
  }

  generateAuthToken() {
    return `${randomUUID()}${randomUUID().replaceAll("-", "")}`;
  }

  async issueAccessToken(sessionId: string, memberId: string) {
    const token = this.generateAuthToken();
    await this.database.insert(accessTokens).values({
      id: randomUUID(),
      sessionId,
      memberId,
      token,
      expiresAt: this.createAccessTokenExpiry()
    });
    return token;
  }

  async getSessionAccess(sessionId: string, token: string) {
    const tokenRecord = await this.database
      .select({
        sessionId: accessTokens.sessionId,
        memberId: accessTokens.memberId,
        userId: sessionMembers.userId,
        role: sessionMembers.role,
        displayName: users.displayName
      })
      .from(accessTokens)
      .innerJoin(sessionMembers, eq(accessTokens.memberId, sessionMembers.id))
      .innerJoin(users, eq(sessionMembers.userId, users.id))
      .where(eq(accessTokens.token, token));

    const match = tokenRecord.find((record: any) => record.sessionId === sessionId);
    if (!match) {
      const error = new Error("Unauthorized");
      // @ts-expect-error custom status code for Fastify
      error.statusCode = 401;
      throw error;
    }

    await this.database
      .update(accessTokens)
      .set({ lastSeenAt: new Date() })
      .where(eq(accessTokens.token, token));

    return {
      token,
      sessionId,
      memberId: match.memberId,
      userId: match.userId,
      displayName: match.displayName,
      role: match.role
    } satisfies SessionAccessContext;
  }
}
