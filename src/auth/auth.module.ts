import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SupabaseModule } from "../common/supabase/supabase.module";

@Module({
  // JwtModule is configured globally in AppModule; no need to import again here.
  imports: [SupabaseModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

