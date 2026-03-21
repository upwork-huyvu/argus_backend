import { Module } from "@nestjs/common";
import { SupabaseModule } from "../common/supabase/supabase.module";
import { ArksController } from "./arks.controller";
import { ArksService } from "./arks.service";

@Module({
  imports: [SupabaseModule],
  controllers: [ArksController],
  providers: [ArksService],
})
export class ArksModule {}

