import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SupabaseService } from "./supabase.service";

// Global so JwtAuthGuard (which depends on SupabaseService) can be used from
// any controller without its owning module having to re-import SupabaseModule.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}

