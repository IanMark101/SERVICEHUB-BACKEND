import { z } from "zod";

export const DeleteOwnAccountSchema = z.discriminatedUnion("method", [
  z.object({ confirmation: z.literal("DELETE"), method: z.literal("password"), password: z.string().min(1).max(128) }).strict(),
  z.object({ confirmation: z.literal("DELETE"), method: z.literal("google"), credential: z.string().min(1).max(8192), challenge: z.string().min(1).max(2048) }).strict(),
]);
export type DeleteOwnAccountInput = z.infer<typeof DeleteOwnAccountSchema>;
