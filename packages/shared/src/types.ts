export type AppRole = "rider" | "driver" | "agent" | "admin";

export type JwtClaims = {
  sub: string;
  roles: AppRole[];
  tenantId?: string | null;
};

