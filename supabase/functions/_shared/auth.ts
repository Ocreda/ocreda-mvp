import {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2";

export type UntypedSupabaseClient = SupabaseClient<any, any, any, any, any>;

export interface AuthenticatedRequest {
  token: string;
  user: User;
  userClient: UntypedSupabaseClient;
}

export async function authenticateRequest(
  req: Request,
): Promise<AuthenticatedRequest> {
  const authorization = req.headers.get("Authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("AUTHENTICATION_REQUIRED");

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) throw new Error("INVALID_SESSION");

  return { token, user: data.user, userClient };
}

/**
 * The verified signed-in user behind a request. Functions that read or write a
 * person's data with the service role must scope every query to this id, and
 * never to a user id taken from the request body, which anyone can set.
 */
export async function verifiedUserId(req: Request): Promise<string> {
  return (await authenticateRequest(req)).user.id;
}

export function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error &&
    (error.message === "AUTHENTICATION_REQUIRED" ||
      error.message === "INVALID_SESSION");
}
