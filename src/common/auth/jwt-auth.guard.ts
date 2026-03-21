import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import jwt from "jsonwebtoken";

type JwtPayload = {
  sub: string;
  role: string;
};

export type AuthUser = {
  userId: string;
  role: string;
  accessToken: string;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const token = authHeader.slice("bearer ".length);
    const raw = this.config.get<string>("JWT_SECRET");
    const secret = raw?.trim() ? raw.trim() : "dev_jwt_secret";

    try {
      const payload = jwt.verify(token, secret, {
        algorithms: ["HS256"],
      }) as unknown as JwtPayload;

      if (!payload?.sub || !payload?.role) throw new UnauthorizedException("Unauthorized.");

      req.user = { userId: payload.sub, role: payload.role, accessToken: token };
      return true;
    } catch {
      throw new UnauthorizedException("Unauthorized.");
    }
  }
}

