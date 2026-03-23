export type AppRole = "rider" | "driver" | "partner" | "partner_employee" | "admin";

export type JwtClaims = {
  sub: string;
  roles: AppRole[];
  tenantId?: string | null;
};

